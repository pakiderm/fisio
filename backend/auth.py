"""Authentication: email+password (JWT-style session tokens), Emergent-managed
Google Auth (session_id exchange), and Sign in with Apple (identity_token
verification against Apple JWKS).

All three providers create the SAME kind of `user_sessions.session_token` (a
random 64-hex UUID). Every business endpoint uses `current_user` to resolve
the caller by that token.
"""

from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Optional

import bcrypt
import httpx
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger(__name__)


APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"
EMERGENT_SESSION_URL = (
    "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"
)
SESSION_TTL_DAYS = 30


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class GoogleSessionIn(BaseModel):
    session_id: str


class AppleSignInIn(BaseModel):
    identity_token: str
    nonce: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None


class PublicUser(BaseModel):
    id: str
    email: Optional[str] = None
    first_name: str = ""
    last_name: str = ""
    picture: Optional[str] = None
    auth_providers: list[str] = []


class AuthResponse(BaseModel):
    session_token: str
    expires_at: datetime
    user: PublicUser


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _norm_email(email: str) -> str:
    return email.strip().lower()


def _hash_pw(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_pw(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


def _public(user: dict) -> PublicUser:
    return PublicUser(
        id=user["id"],
        email=user.get("email"),
        first_name=user.get("first_name", ""),
        last_name=user.get("last_name", ""),
        picture=user.get("picture"),
        auth_providers=user.get("auth_providers", []),
    )


def _to_aware(dt) -> datetime:
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
    if isinstance(dt, datetime) and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def _issue_session(db: AsyncIOMotorDatabase, user: dict, provider: str) -> AuthResponse:
    token = secrets.token_hex(32)
    exp = _now() + timedelta(days=SESSION_TTL_DAYS)
    await db.user_sessions.insert_one(
        {
            "session_token": token,
            "user_id": user["id"],
            "provider": provider,
            "created_at": _now(),
            "expires_at": exp,
        }
    )
    return AuthResponse(session_token=token, expires_at=exp, user=_public(user))


async def _upsert_user_by_email(
    db: AsyncIOMotorDatabase,
    email: Optional[str],
    provider: str,
    defaults: dict,
) -> dict:
    """Upsert a user by verified email or create a new one. Adds `provider` to
    auth_providers."""
    now = _now()
    if email:
        email = _norm_email(email)
        existing = await db.users.find_one({"email": email}, {"_id": 0})
    else:
        existing = None

    if existing:
        upd: dict[str, Any] = {"updated_at": now}
        # merge missing fields
        for k, v in defaults.items():
            if v and not existing.get(k):
                upd[k] = v
        await db.users.update_one(
            {"id": existing["id"]},
            {"$set": upd, "$addToSet": {"auth_providers": provider}},
        )
        return await db.users.find_one({"id": existing["id"]}, {"_id": 0})

    # create
    new_id = f"user_{uuid.uuid4().hex[:12]}"
    doc = {
        "id": new_id,
        "email": email,
        "first_name": defaults.get("first_name", ""),
        "last_name": defaults.get("last_name", ""),
        "picture": defaults.get("picture"),
        "password_hash": None,
        "google_sub": defaults.get("google_sub"),
        "apple_sub": defaults.get("apple_sub"),
        "auth_providers": [provider],
        "created_at": now,
        "updated_at": now,
    }
    await db.users.insert_one(doc)
    return await db.users.find_one({"id": new_id}, {"_id": 0})


# ---------------------------------------------------------------------------
# Current user dependency (factory that captures the db handle)
# ---------------------------------------------------------------------------


def make_current_user_dep(db: AsyncIOMotorDatabase):
    async def current_user(authorization: Annotated[Optional[str], Header()] = None) -> dict:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing bearer token",
            )
        token = authorization[7:].strip()
        session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
        if not session:
            raise HTTPException(401, "Invalid session")
        exp = _to_aware(session.get("expires_at"))
        if exp and exp < _now():
            await db.user_sessions.delete_one({"session_token": token})
            raise HTTPException(401, "Session expired")
        user = await db.users.find_one({"id": session["user_id"]}, {"_id": 0})
        if not user:
            raise HTTPException(401, "User not found")
        user["_session_token"] = token
        return user

    return current_user


# ---------------------------------------------------------------------------
# Apple identity_token verification
# ---------------------------------------------------------------------------


_apple_jwks_cache: dict[str, Any] = {"keys": None, "fetched_at": None}


async def _apple_jwks() -> dict:
    if (
        _apple_jwks_cache["keys"]
        and _apple_jwks_cache["fetched_at"]
        and _now() - _apple_jwks_cache["fetched_at"] < timedelta(hours=6)
    ):
        return _apple_jwks_cache["keys"]
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(APPLE_JWKS_URL)
        r.raise_for_status()
    _apple_jwks_cache["keys"] = r.json()
    _apple_jwks_cache["fetched_at"] = _now()
    return _apple_jwks_cache["keys"]


async def _verify_apple(identity_token: str, expected_nonce: Optional[str]) -> dict:
    try:
        jwks = await _apple_jwks()
        unverified = jwt.get_unverified_header(identity_token)
        kid = unverified.get("kid")
        key_data = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        if not key_data:
            raise HTTPException(401, "Apple key not found")
        key = jwt.algorithms.RSAAlgorithm.from_jwk(key_data)
        bundle = os.getenv("APPLE_BUNDLE_ID", "com.emergent.appointmentinvoice.ij82hx")
        payload = jwt.decode(
            identity_token,
            key=key,
            algorithms=[unverified.get("alg", "RS256")],
            audience=bundle,
            issuer=APPLE_ISSUER,
        )
    except HTTPException:
        raise
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid Apple token: {e}")
    except Exception as e:
        logger.warning("Apple verification failed: %s", e)
        raise HTTPException(401, "Invalid Apple token")
    if expected_nonce and payload.get("nonce") and payload["nonce"] != expected_nonce:
        raise HTTPException(401, "Nonce mismatch")
    return payload


# ---------------------------------------------------------------------------
# Router builder
# ---------------------------------------------------------------------------


def build_auth_router(db: AsyncIOMotorDatabase) -> APIRouter:
    router = APIRouter(prefix="/auth", tags=["auth"])
    current_user = make_current_user_dep(db)

    @router.post("/register", response_model=AuthResponse, status_code=201)
    async def register(body: RegisterIn):
        email = _norm_email(body.email)
        existing = await db.users.find_one({"email": email}, {"_id": 0})
        if existing and existing.get("password_hash"):
            raise HTTPException(409, "Email già registrata")
        now = _now()
        if existing:
            await db.users.update_one(
                {"id": existing["id"]},
                {
                    "$set": {
                        "password_hash": _hash_pw(body.password),
                        "first_name": body.first_name,
                        "last_name": body.last_name,
                        "updated_at": now,
                    },
                    "$addToSet": {"auth_providers": "password"},
                },
            )
            user = await db.users.find_one({"id": existing["id"]}, {"_id": 0})
        else:
            new_id = f"user_{uuid.uuid4().hex[:12]}"
            doc = {
                "id": new_id,
                "email": email,
                "first_name": body.first_name,
                "last_name": body.last_name,
                "picture": None,
                "password_hash": _hash_pw(body.password),
                "google_sub": None,
                "apple_sub": None,
                "auth_providers": ["password"],
                "created_at": now,
                "updated_at": now,
            }
            await db.users.insert_one(doc)
            user = await db.users.find_one({"id": new_id}, {"_id": 0})
        return await _issue_session(db, user, "password")

    @router.post("/login", response_model=AuthResponse)
    async def login(body: LoginIn):
        user = await db.users.find_one({"email": _norm_email(body.email)}, {"_id": 0})
        if not user or not user.get("password_hash") or not _check_pw(
            body.password, user["password_hash"]
        ):
            raise HTTPException(401, "Email o password errati")
        return await _issue_session(db, user, "password")

    @router.post("/session", response_model=AuthResponse)
    async def google_session(body: GoogleSessionIn):
        """Exchange Emergent Google `session_id` for a session_token."""
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                EMERGENT_SESSION_URL, headers={"X-Session-ID": body.session_id}
            )
        if r.status_code != 200:
            logger.warning("Google session exchange failed %s: %s", r.status_code, r.text)
            raise HTTPException(401, "Autenticazione Google non riuscita")
        data = r.json()
        email = data.get("email")
        name = data.get("name", "") or ""
        parts = name.split(" ", 1)
        first_name = parts[0] if parts else ""
        last_name = parts[1] if len(parts) > 1 else ""
        user = await _upsert_user_by_email(
            db,
            email=email,
            provider="google",
            defaults={
                "first_name": first_name,
                "last_name": last_name,
                "picture": data.get("picture"),
                "google_sub": data.get("id") or data.get("sub"),
            },
        )
        return await _issue_session(db, user, "google")

    @router.post("/apple", response_model=AuthResponse)
    async def apple_signin(body: AppleSignInIn):
        payload = await _verify_apple(body.identity_token, body.nonce)
        apple_sub = payload.get("sub")
        email = payload.get("email")
        # Apple returns name only on first authorization; the client passes it in
        user = await _upsert_user_by_email(
            db,
            email=email,
            provider="apple",
            defaults={
                "first_name": body.first_name or "",
                "last_name": body.last_name or "",
                "apple_sub": apple_sub,
            },
        )
        # Ensure apple_sub is stored even if user existed and had it null
        if apple_sub and not user.get("apple_sub"):
            await db.users.update_one(
                {"id": user["id"]}, {"$set": {"apple_sub": apple_sub}}
            )
            user["apple_sub"] = apple_sub
        return await _issue_session(db, user, "apple")

    @router.get("/me", response_model=PublicUser)
    async def me(user: dict = Depends(current_user)):
        return _public(user)

    @router.post("/logout", status_code=204)
    async def logout(user: dict = Depends(current_user)):
        await db.user_sessions.delete_one({"session_token": user["_session_token"]})
        return None

    return router
