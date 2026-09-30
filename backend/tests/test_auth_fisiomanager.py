"""FisioManager auth + multi-user isolation regression tests.

Covers:
- 401 on protected endpoints without/invalid tokens
- Register + Login (email/password) with bcrypt
- /auth/me + /auth/logout
- Google session (invalid session_id -> 401)
- Apple sign-in (invalid identity_token -> 401)
- Data isolation per user_id (patients, appointments, settings, invoices, voice)
- Full invoice flow with authenticated user (7*1.5h @ 50€ + 2€ = 527€)
- Per-user invoice numbering (both users start at 1)
- No `_id` / `user_id` leakage in responses
"""
from __future__ import annotations

import os
import re
import uuid
from datetime import date
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent / "frontend" / ".env")

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
).rstrip("/")

UUID_RE = re.compile(r"^[0-9a-f-]{36}$")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def _mkemail(prefix: str) -> str:
    return f"TEST_{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def _register(email: str, password: str = "p@ssw0rd!", fn: str = "Fn", ln: str = "Ln"):
    r = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": password, "first_name": fn, "last_name": ln},
        timeout=15,
    )
    return r


@pytest.fixture(scope="module")
def user_a():
    email = _mkemail("A")
    r = _register(email, fn="Alice", ln="Alpha")
    assert r.status_code == 201, r.text
    data = r.json()
    return {"email": email, "password": "p@ssw0rd!", "token": data["session_token"], "user": data["user"]}


@pytest.fixture(scope="module")
def user_b():
    email = _mkemail("B")
    r = _register(email, fn="Bob", ln="Beta")
    assert r.status_code == 201, r.text
    data = r.json()
    return {"email": email, "password": "p@ssw0rd!", "token": data["session_token"], "user": data["user"]}


def hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# 1) Unauthenticated returns 401
# ---------------------------------------------------------------------------
class TestUnauthenticated:
    @pytest.mark.parametrize("path,method,payload", [
        ("/api/patients", "get", None),
        ("/api/settings", "get", None),
        ("/api/appointments", "get", None),
        ("/api/invoices", "get", None),
        ("/api/voice/plan", "post", {"text": "hi", "today": "2026-04-01"}),
    ])
    def test_protected_requires_bearer(self, path, method, payload):
        fn = getattr(requests, method)
        if payload is None:
            r = fn(f"{BASE_URL}{path}", timeout=10)
        else:
            r = fn(f"{BASE_URL}{path}", json=payload, timeout=10)
        assert r.status_code == 401, f"{path} expected 401 got {r.status_code}: {r.text}"

    def test_invalid_bearer_token(self):
        r = requests.get(
            f"{BASE_URL}/api/patients",
            headers={"Authorization": "Bearer not_a_real_token"},
            timeout=10,
        )
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# 2) Register / Login / me / logout
# ---------------------------------------------------------------------------
class TestAuthEmailPassword:
    def test_register_returns_session_and_user(self):
        email = _mkemail("R")
        r = _register(email)
        assert r.status_code == 201
        d = r.json()
        assert "session_token" in d and isinstance(d["session_token"], str)
        assert "user" in d
        assert d["user"]["email"] == email.lower()
        assert d["user"]["first_name"] == "Fn"
        assert "id" in d["user"]
        # no _id leakage
        assert "_id" not in d and "_id" not in d["user"]
        assert "password_hash" not in d["user"]

    def test_duplicate_register_conflict(self):
        email = _mkemail("Dup")
        assert _register(email).status_code == 201
        r2 = _register(email)
        assert r2.status_code == 409

    def test_login_success_and_wrong_password(self):
        email = _mkemail("Login")
        assert _register(email, password="p@ssw0rd!").status_code == 201
        r_ok = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": email, "password": "p@ssw0rd!"},
            timeout=10,
        )
        assert r_ok.status_code == 200
        assert "session_token" in r_ok.json()

        r_bad = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": email, "password": "WRONG"},
            timeout=10,
        )
        assert r_bad.status_code == 401

    def test_me_with_and_without_token(self, user_a):
        r_ok = requests.get(f"{BASE_URL}/api/auth/me", headers=hdr(user_a["token"]), timeout=10)
        assert r_ok.status_code == 200
        me = r_ok.json()
        assert me["id"] == user_a["user"]["id"]
        assert me["email"] == user_a["email"].lower()
        assert "_id" not in me and "password_hash" not in me

        r_no = requests.get(f"{BASE_URL}/api/auth/me", timeout=10)
        assert r_no.status_code == 401

        r_bad = requests.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": "Bearer abc123"},
            timeout=10,
        )
        assert r_bad.status_code == 401

    def test_logout_invalidates_token(self):
        email = _mkemail("Logout")
        r = _register(email)
        token = r.json()["session_token"]
        rl = requests.post(f"{BASE_URL}/api/auth/logout", headers=hdr(token), timeout=10)
        assert rl.status_code == 204
        rme = requests.get(f"{BASE_URL}/api/auth/me", headers=hdr(token), timeout=10)
        assert rme.status_code == 401


# ---------------------------------------------------------------------------
# 3) Google + Apple invalid inputs -> 401
# ---------------------------------------------------------------------------
class TestOAuthInvalid:
    def test_google_invalid_session_id(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/session",
            json={"session_id": f"invalid_{uuid.uuid4().hex}"},
            timeout=20,
        )
        assert r.status_code == 401

    def test_apple_invalid_identity_token(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "not.a.valid.jwt"},
            timeout=20,
        )
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# 4) Data isolation between two users
# ---------------------------------------------------------------------------
class TestIsolation:
    def test_patient_created_by_a_not_visible_to_b(self, user_a, user_b):
        r = requests.post(
            f"{BASE_URL}/api/patients",
            headers=hdr(user_a["token"]),
            json={"first_name": "TEST_ISO", "last_name": "TEST_USERA"},
            timeout=10,
        )
        assert r.status_code == 200
        pid = r.json()["id"]
        assert "user_id" not in r.json() and "_id" not in r.json()

        # B: list must NOT include it
        rb = requests.get(f"{BASE_URL}/api/patients", headers=hdr(user_b["token"]), timeout=10)
        assert rb.status_code == 200
        assert all(p["id"] != pid for p in rb.json())

        # B: cannot GET, UPDATE, DELETE
        assert requests.get(f"{BASE_URL}/api/patients/{pid}", headers=hdr(user_b["token"])).status_code == 404
        assert requests.put(
            f"{BASE_URL}/api/patients/{pid}",
            headers=hdr(user_b["token"]),
            json={"city": "Hack"},
        ).status_code == 404
        assert requests.delete(f"{BASE_URL}/api/patients/{pid}", headers=hdr(user_b["token"])).status_code == 404

        # A can still see + delete
        assert requests.get(f"{BASE_URL}/api/patients/{pid}", headers=hdr(user_a["token"])).status_code == 200
        requests.delete(f"{BASE_URL}/api/patients/{pid}", headers=hdr(user_a["token"]))

    def test_appointments_isolated(self, user_a, user_b):
        # A creates a patient + appointment
        pa = requests.post(
            f"{BASE_URL}/api/patients",
            headers=hdr(user_a["token"]),
            json={"first_name": "TEST_APP", "last_name": "TEST_A"},
        ).json()
        appt = requests.post(
            f"{BASE_URL}/api/appointments",
            headers=hdr(user_a["token"]),
            json={
                "patient_id": pa["id"],
                "date": "2026-04-06",
                "start_time": "09:00",
                "end_time": "10:00",
            },
        ).json()
        assert len(appt) == 1
        appt_id = appt[0]["id"]

        # B: list must not include appt
        rb = requests.get(
            f"{BASE_URL}/api/appointments",
            headers=hdr(user_b["token"]),
            params={"start": "2026-04-01", "end": "2026-04-30"},
        ).json()
        assert all(a["id"] != appt_id for a in rb)
        # B cannot GET individually either
        assert requests.get(
            f"{BASE_URL}/api/appointments/{appt_id}", headers=hdr(user_b["token"])
        ).status_code == 404
        # cleanup
        requests.delete(f"{BASE_URL}/api/appointments/{appt_id}", headers=hdr(user_a["token"]))
        requests.delete(f"{BASE_URL}/api/patients/{pa['id']}", headers=hdr(user_a["token"]))

    def test_settings_per_user(self, user_a, user_b):
        # A changes rate to 60, B default is 50
        r = requests.put(
            f"{BASE_URL}/api/settings",
            headers=hdr(user_a["token"]),
            json={"hourly_rate": 60.0},
        )
        assert r.status_code == 200
        assert r.json()["hourly_rate"] == 60.0

        rb = requests.get(f"{BASE_URL}/api/settings", headers=hdr(user_b["token"])).json()
        assert rb["hourly_rate"] == 50.0
        assert "_id" not in rb
        # And user_id should not be leaked as `user_id`
        assert "user_id" not in rb
        # Restore for downstream invoice test
        requests.put(
            f"{BASE_URL}/api/settings",
            headers=hdr(user_a["token"]),
            json={"hourly_rate": 50.0},
        )


# ---------------------------------------------------------------------------
# 5) Full authenticated invoice flow: April 2026, 527€
# ---------------------------------------------------------------------------
class TestInvoiceFlow:
    inv_id_a = None

    def test_invoice_flow_user_a_527_euros(self, user_a):
        # Ensure rate 50 for A
        requests.put(
            f"{BASE_URL}/api/settings",
            headers=hdr(user_a["token"]),
            json={"hourly_rate": 50.0},
        )
        # Patient
        p = requests.post(
            f"{BASE_URL}/api/patients",
            headers=hdr(user_a["token"]),
            json={
                "first_name": "TEST_Luca",
                "last_name": "TEST_Verdi",
                "codice_fiscale": "VRDLCU80A01H501Z",
                "hcp_code": "HCP527",
            },
        ).json()
        # 7 appointments of 1.5h in April 2026 (avoid past)
        for i in range(7):
            d = date(2026, 4, 6 + i)
            r = requests.post(
                f"{BASE_URL}/api/appointments",
                headers=hdr(user_a["token"]),
                json={
                    "patient_id": p["id"],
                    "date": d.isoformat(),
                    "start_time": "09:00",
                    "end_time": "10:30",
                },
            )
            assert r.status_code == 200, r.text

        # Preview
        prev = requests.post(
            f"{BASE_URL}/api/invoices/preview",
            headers=hdr(user_a["token"]),
            json={"patient_id": p["id"], "year": 2026, "month": 4},
        ).json()
        assert len(prev["lines"]) == 7
        assert prev["total_hours"] == 10.5
        assert prev["imponibile"] == 525.0
        assert prev["total"] == 527.0

        # Confirm
        conf = requests.post(
            f"{BASE_URL}/api/invoices/confirm",
            headers=hdr(user_a["token"]),
            json={"patient_id": p["id"], "year": 2026, "month": 4},
        )
        assert conf.status_code == 200, conf.text
        inv = conf.json()
        assert inv["total"] == 527.0
        assert inv["imponibile"] == 525.0
        assert "user_id" not in inv and "_id" not in inv
        TestInvoiceFlow.inv_id_a = inv["id"]
        TestInvoiceFlow.patient_a = p["id"]

        # xlsx / pdf downloads succeed
        rx = requests.get(
            f"{BASE_URL}/api/invoices/{inv['id']}/download",
            headers=hdr(user_a["token"]),
            params={"fmt": "xlsx"},
        )
        assert rx.status_code == 200
        rp = requests.get(
            f"{BASE_URL}/api/invoices/{inv['id']}/download",
            headers=hdr(user_a["token"]),
            params={"fmt": "pdf"},
        )
        assert rp.status_code == 200
        assert rp.content[:4] == b"%PDF"

    def test_user_b_cannot_download_user_a_invoice(self, user_b):
        assert TestInvoiceFlow.inv_id_a is not None
        r = requests.get(
            f"{BASE_URL}/api/invoices/{TestInvoiceFlow.inv_id_a}/download",
            headers=hdr(user_b["token"]),
            params={"fmt": "xlsx"},
        )
        assert r.status_code == 404
        r2 = requests.get(
            f"{BASE_URL}/api/invoices/{TestInvoiceFlow.inv_id_a}",
            headers=hdr(user_b["token"]),
        )
        assert r2.status_code == 404


# ---------------------------------------------------------------------------
# 6) Per-user invoice numbering: both users get #1
# ---------------------------------------------------------------------------
class TestPerUserInvoiceNumbering:
    def test_both_users_can_have_invoice_number_1(self):
        # fresh users
        ea = _mkemail("Num_A")
        eb = _mkemail("Num_B")
        ta = _register(ea).json()["session_token"]
        tb = _register(eb).json()["session_token"]

        for tok in (ta, tb):
            # Ensure counter still 1 (fresh)
            s = requests.get(f"{BASE_URL}/api/settings", headers=hdr(tok)).json()
            assert s["next_invoice_number"] == 1
            # Create patient + one appt in May 2026
            p = requests.post(
                f"{BASE_URL}/api/patients",
                headers=hdr(tok),
                json={"first_name": "N1", "last_name": "Zero"},
            ).json()
            ap = requests.post(
                f"{BASE_URL}/api/appointments",
                headers=hdr(tok),
                json={
                    "patient_id": p["id"],
                    "date": "2026-05-04",
                    "start_time": "09:00",
                    "end_time": "10:00",
                },
            )
            assert ap.status_code == 200
            r = requests.post(
                f"{BASE_URL}/api/invoices/confirm",
                headers=hdr(tok),
                json={"patient_id": p["id"], "year": 2026, "month": 5},
            )
            assert r.status_code == 200, r.text
            assert r.json()["number"] == 1
            assert r.json()["number_full"] == "1/HCP"


# ---------------------------------------------------------------------------
# 7) Voice /plan auth + isolation
# ---------------------------------------------------------------------------
class TestVoiceAuth:
    def test_voice_plan_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/voice/plan",
            json={"text": "ciao", "today": "2026-04-01"},
            timeout=10,
        )
        assert r.status_code == 401

    def test_voice_plan_scoped_to_user(self, user_a, user_b):
        # Create patient "Giulia Ferrari" ONLY for user A
        p = requests.post(
            f"{BASE_URL}/api/patients",
            headers=hdr(user_a["token"]),
            json={"first_name": "Giulia", "last_name": "Ferrari"},
        ).json()
        try:
            r = requests.post(
                f"{BASE_URL}/api/voice/plan",
                headers=hdr(user_a["token"]),
                json={
                    "text": "Domani alle 9 metti Giulia Ferrari per un'ora e mezza",
                    "today": "2026-04-01",
                },
                timeout=60,
            )
            assert r.status_code == 200, r.text
            # B does not see Giulia
            rb = requests.get(
                f"{BASE_URL}/api/patients",
                headers=hdr(user_b["token"]),
                params={"q": "Ferrari"},
            ).json()
            assert not any(pt["last_name"] == "Ferrari" for pt in rb)
        finally:
            appts = requests.get(
                f"{BASE_URL}/api/appointments",
                headers=hdr(user_a["token"]),
                params={"patient_id": p["id"]},
            ).json()
            for a in appts:
                requests.delete(
                    f"{BASE_URL}/api/appointments/{a['id']}",
                    headers=hdr(user_a["token"]),
                )
            requests.delete(
                f"{BASE_URL}/api/patients/{p['id']}", headers=hdr(user_a["token"])
            )
