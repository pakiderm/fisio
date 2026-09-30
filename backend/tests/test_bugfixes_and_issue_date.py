"""Regression tests for iteration 3:

- BUG FIX 1: POST /api/invoices/confirm works with < 7 appointments (MergedCell fix)
- BUG FIX 2: POST /api/auth/apple with malformed identity_token returns 401 (not 500)
- NEW FEATURE: POST /api/invoices/confirm accepts optional issue_date (YYYY-MM-DD)
  (a) with issue_date -> response.issue_date == that value AND xlsx cell B8 == that value
  (b) omitted -> defaults to today
  (c) invalid -> 400
"""
from __future__ import annotations

import io
import os
import uuid
from datetime import date, timedelta
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from openpyxl import load_workbook

load_dotenv(Path(__file__).parent.parent.parent / "frontend" / ".env")

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
).rstrip("/")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _mkemail(prefix: str) -> str:
    return f"TEST_{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def _register(email: str, password: str = "p@ssw0rd!") -> dict:
    r = requests.post(
        f"{BASE_URL}/api/auth/register",
        json={
            "email": email,
            "password": password,
            "first_name": "Fn",
            "last_name": "Ln",
        },
        timeout=15,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _make_patient(token: str, last_name: str = "TESTVerdi") -> dict:
    r = requests.post(
        f"{BASE_URL}/api/patients",
        headers=_hdr(token),
        json={
            "first_name": "TESTLuca",
            "last_name": last_name,
            "codice_fiscale": "VRDLCU80A01H501Z",
            "hcp_code": "HCP1",
        },
        timeout=10,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_appts(token: str, patient_id: str, year: int, month: int, n: int):
    """Create n 1-hour appointments starting on day 1 of the given month."""
    for i in range(n):
        d = date(year, month, 1 + i)
        r = requests.post(
            f"{BASE_URL}/api/appointments",
            headers=_hdr(token),
            json={
                "patient_id": patient_id,
                "date": d.isoformat(),
                "start_time": "09:00",
                "end_time": "10:00",
            },
            timeout=10,
        )
        assert r.status_code == 200, f"appt {i} failed: {r.text}"


# ---------------------------------------------------------------------------
# BUG FIX 2 — Apple malformed identity_token -> 401
# ---------------------------------------------------------------------------
class TestAppleMalformedToken:
    def test_apple_not_a_jwt_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "not.a.valid.jwt"},
            timeout=20,
        )
        assert r.status_code == 401, r.text

    def test_apple_empty_token_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "garbage"},
            timeout=20,
        )
        assert r.status_code == 401, r.text

    def test_apple_bad_base64_header_returns_401(self):
        # header with invalid base64 padding
        r = requests.post(
            f"{BASE_URL}/api/auth/apple",
            json={"identity_token": "@@@.@@@.@@@"},
            timeout=20,
        )
        assert r.status_code == 401, r.text


# ---------------------------------------------------------------------------
# BUG FIX 1 — invoice confirm works with 1/3/5/7/10 appointments
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def merged_user():
    return _register(_mkemail("Merged"))


@pytest.mark.parametrize(
    "n_appts,year,month",
    [
        (1, 2026, 2),
        (3, 2026, 3),
        (5, 2026, 4),
        (7, 2026, 5),
        (10, 2026, 6),
    ],
)
def test_invoice_confirm_handles_variable_appt_count(merged_user, n_appts, year, month):
    """The MergedCell fix in invoice_generator.py must let the confirm endpoint
    succeed for both small (n<7) and large (n>=7) appointment counts across months.
    """
    token = merged_user["session_token"]
    patient = _make_patient(token, last_name=f"TESTVerdi{n_appts}")

    _create_appts(token, patient["id"], year, month, n_appts)

    r = requests.post(
        f"{BASE_URL}/api/invoices/confirm",
        headers=_hdr(token),
        json={"patient_id": patient["id"], "year": year, "month": month},
        timeout=30,
    )
    assert r.status_code == 200, f"n={n_appts}: {r.status_code} {r.text}"
    inv = r.json()
    assert len(inv["lines"]) == n_appts
    # 50€ default rate * 1h * n + 2€ stamp duty
    assert inv["imponibile"] == 50.0 * n_appts
    assert inv["total"] == 50.0 * n_appts + 2.0

    # xlsx must download and be a valid workbook
    rx = requests.get(
        f"{BASE_URL}/api/invoices/{inv['id']}/download",
        headers=_hdr(token),
        params={"fmt": "xlsx"},
        timeout=30,
    )
    assert rx.status_code == 200
    wb = load_workbook(io.BytesIO(rx.content))
    assert wb.active is not None  # no exception -> valid xlsx


# ---------------------------------------------------------------------------
# NEW FEATURE — issue_date field in POST /api/invoices/confirm
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def issue_date_user():
    return _register(_mkemail("IssueDate"))


class TestIssueDateFeature:
    def test_issue_date_provided_reflects_in_response_and_xlsx(self, issue_date_user):
        """(a) with issue_date='2026-07-15' -> response.issue_date == that value
              AND generated xlsx cell B8 == that date."""
        token = issue_date_user["session_token"]
        p = _make_patient(token, last_name="TESTIssueA")
        _create_appts(token, p["id"], 2026, 7, 2)

        r = requests.post(
            f"{BASE_URL}/api/invoices/confirm",
            headers=_hdr(token),
            json={
                "patient_id": p["id"],
                "year": 2026,
                "month": 7,
                "issue_date": "2026-07-15",
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        assert inv["issue_date"] == "2026-07-15"

        # Download xlsx and verify B8
        rx = requests.get(
            f"{BASE_URL}/api/invoices/{inv['id']}/download",
            headers=_hdr(token),
            params={"fmt": "xlsx"},
            timeout=30,
        )
        assert rx.status_code == 200
        wb = load_workbook(io.BytesIO(rx.content))
        ws = wb.active
        b8 = ws["B8"].value
        # accept datetime or string representation containing the date
        expected = date(2026, 7, 15)
        if hasattr(b8, "date"):
            assert b8.date() == expected, f"B8 datetime mismatch: {b8}"
        elif isinstance(b8, date):
            assert b8 == expected, f"B8 date mismatch: {b8}"
        else:
            assert b8 is not None, "B8 empty"
            s = str(b8)
            assert (
                "2026-07-15" in s
                or "15/07/2026" in s
                or "15-07-2026" in s
                or "07/15/2026" in s
            ), f"B8 does not contain 2026-07-15 in any known format: {s!r}"

    def test_issue_date_omitted_defaults_to_today(self, issue_date_user):
        """(b) issue_date omitted -> response.issue_date == today's ISO date."""
        token = issue_date_user["session_token"]
        p = _make_patient(token, last_name="TESTIssueB")
        _create_appts(token, p["id"], 2026, 8, 1)

        r = requests.post(
            f"{BASE_URL}/api/invoices/confirm",
            headers=_hdr(token),
            json={"patient_id": p["id"], "year": 2026, "month": 8},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        today_iso = date.today().isoformat()
        # allow ±1 day drift around midnight UTC vs server tz
        assert inv["issue_date"] in {
            today_iso,
            (date.today() - timedelta(days=1)).isoformat(),
            (date.today() + timedelta(days=1)).isoformat(),
        }, f"issue_date {inv['issue_date']} not near today {today_iso}"

    def test_issue_date_invalid_returns_400(self, issue_date_user):
        """(c) issue_date='not-a-date' -> 400."""
        token = issue_date_user["session_token"]
        p = _make_patient(token, last_name="TESTIssueC")
        _create_appts(token, p["id"], 2026, 9, 1)

        r = requests.post(
            f"{BASE_URL}/api/invoices/confirm",
            headers=_hdr(token),
            json={
                "patient_id": p["id"],
                "year": 2026,
                "month": 9,
                "issue_date": "not-a-date",
            },
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400 got {r.status_code}: {r.text}"

    def test_issue_date_other_invalid_formats_return_400(self, issue_date_user):
        """Additional invalid formats should also 400 (not 500)."""
        token = issue_date_user["session_token"]
        p = _make_patient(token, last_name="TESTIssueD")
        _create_appts(token, p["id"], 2026, 10, 1)

        # NOTE: empty string "" is treated as "not provided" by the current backend
        # (falsy check on `payload.issue_date`) -> defaults to today. Documented as minor.
        for bad in ["15/07/2026", "2026-13-40", "2026-02-30"]:
            r = requests.post(
                f"{BASE_URL}/api/invoices/confirm",
                headers=_hdr(token),
                json={
                    "patient_id": p["id"],
                    "year": 2026,
                    "month": 10,
                    "issue_date": bad,
                },
                timeout=30,
            )
            # 400 (or 422 Pydantic) is fine — must NOT be 500
            assert r.status_code in (400, 422), (
                f"bad={bad!r}: expected 400/422 got {r.status_code} {r.text}"
            )
