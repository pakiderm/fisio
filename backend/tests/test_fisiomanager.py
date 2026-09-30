"""FisioManager backend regression tests.

Covers settings, patients, appointments, invoices (preview/confirm/download,
xlsx template validation), voice endpoints and idempotency/UUID checks.

Uses months (March 2026, April 2026, May 2026) that are unlikely to collide
with manual seed data from Jan 2026 (Arienzo Maria).
"""
import io
import re
import uuid
import zipfile
from datetime import date

import openpyxl
import pytest
import requests

from conftest import BASE_URL


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
class TestSettings:
    def test_get_settings_singleton_defaults(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/settings")
        assert r.status_code == 200
        d = r.json()
        assert d["id"] == "singleton"
        assert d["hourly_rate"] == 50.0 or isinstance(d["hourly_rate"], (int, float))
        assert d["invoice_suffix"] == "/HCP"
        assert d["stamp_duty"] == 2.0
        assert "next_invoice_number" in d
        prof = d["professional"]
        # Default professional data
        assert "Reielli" in prof["name"] or prof["name"]  # accept updates but must exist
        assert "_id" not in d

    def test_put_settings_updates_and_persists(self, api_client):
        # Snapshot
        cur = api_client.get(f"{BASE_URL}/api/settings").json()
        original_rate = cur["hourly_rate"]
        # Update
        new_rate = 55.0
        r = api_client.put(
            f"{BASE_URL}/api/settings",
            json={"hourly_rate": new_rate, "professional": {"phone": "3333333333"}},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["hourly_rate"] == new_rate
        assert d["professional"]["phone"] == "3333333333"
        # GET verifies persistence
        after = api_client.get(f"{BASE_URL}/api/settings").json()
        assert after["hourly_rate"] == new_rate
        # Restore
        api_client.put(f"{BASE_URL}/api/settings", json={"hourly_rate": original_rate})


# ---------------------------------------------------------------------------
# Patients CRUD + search + import + history
# ---------------------------------------------------------------------------
class TestPatientsCRUD:
    created_ids: list = []

    def test_create_patient(self, api_client):
        payload = {
            "first_name": "TEST_Marco",
            "last_name": "TEST_Rossi",
            "codice_fiscale": "RSSMRC80A01H501U",
            "address": "Via Test 1",
            "city": "Roma",
            "cap": "00100",
            "hcp_code": "HCP123",
            "custom_hourly_rate": 60.0,
        }
        r = api_client.post(f"{BASE_URL}/api/patients", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["first_name"] == "TEST_Marco"
        assert d["custom_hourly_rate"] == 60.0
        assert re.match(r"^[0-9a-f-]{36}$", d["id"])  # UUID
        assert "_id" not in d
        TestPatientsCRUD.created_ids.append(d["id"])

    def test_get_patient(self, api_client):
        pid = TestPatientsCRUD.created_ids[0]
        r = api_client.get(f"{BASE_URL}/api/patients/{pid}")
        assert r.status_code == 200
        assert r.json()["id"] == pid

    def test_search_patients_fuzzy(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/patients", params={"q": "TEST_Ros"})
        assert r.status_code == 200
        d = r.json()
        assert any(p["last_name"] == "TEST_Rossi" for p in d)

    def test_update_patient(self, api_client):
        pid = TestPatientsCRUD.created_ids[0]
        r = api_client.put(
            f"{BASE_URL}/api/patients/{pid}", json={"city": "Milano"}
        )
        assert r.status_code == 200
        assert r.json()["city"] == "Milano"
        # Verify via GET
        assert api_client.get(f"{BASE_URL}/api/patients/{pid}").json()["city"] == "Milano"

    def test_import_patients(self, api_client):
        payload = {
            "patients": [
                {"first_name": "TEST_A", "last_name": "TEST_Uno"},
                {"first_name": "TEST_B", "last_name": "TEST_Due"},
            ]
        }
        r = api_client.post(f"{BASE_URL}/api/patients/import", json=payload)
        assert r.status_code == 200
        assert r.json()["imported"] == 2
        # verify present
        found = api_client.get(f"{BASE_URL}/api/patients", params={"q": "TEST_Uno"}).json()
        assert any(p["last_name"] == "TEST_Uno" for p in found)
        # Cleanup
        for p in api_client.get(f"{BASE_URL}/api/patients", params={"q": "TEST_"}).json():
            if p["last_name"] in ("TEST_Uno", "TEST_Due"):
                api_client.delete(f"{BASE_URL}/api/patients/{p['id']}")

    def test_delete_patient_not_found(self, api_client):
        r = api_client.delete(f"{BASE_URL}/api/patients/{uuid.uuid4()}")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Appointments (create single / recurring, update, delete, filters)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def test_patient(api_client):
    payload = {
        "first_name": "TEST_Anna",
        "last_name": "TEST_Bianchi",
        "codice_fiscale": "BNCANN80A41H501R",
        "address": "Via Prova 2",
        "city": "Napoli",
        "cap": "80100",
        "hcp_code": "HCP999",
    }
    r = api_client.post(f"{BASE_URL}/api/patients", json=payload)
    assert r.status_code == 200
    p = r.json()
    yield p
    # cleanup best effort
    api_client.delete(f"{BASE_URL}/api/patients/{p['id']}")


class TestAppointments:
    def test_create_single_appointment(self, api_client, test_patient):
        r = api_client.post(
            f"{BASE_URL}/api/appointments",
            json={
                "patient_id": test_patient["id"],
                "date": "2026-05-04",
                "start_time": "09:00",
                "end_time": "10:00",
            },
        )
        assert r.status_code == 200
        arr = r.json()
        assert len(arr) == 1
        a = arr[0]
        assert a["duration_minutes"] == 60
        # hourly_rate should apply — default global settings rate (last known)
        assert a["amount"] == round(a["hourly_rate"], 2)
        assert re.match(r"^[0-9a-f-]{36}$", a["id"])
        assert "_id" not in a

    def test_create_recurring_weekly(self, api_client, test_patient):
        r = api_client.post(
            f"{BASE_URL}/api/appointments",
            json={
                "patient_id": test_patient["id"],
                "date": "2026-06-01",
                "start_time": "10:00",
                "end_time": "11:00",
                "recurring": True,
                "recurring_until": "2026-06-22",
                "recurring_frequency": "weekly",
            },
        )
        assert r.status_code == 200
        arr = r.json()
        assert len(arr) == 4  # 01, 08, 15, 22
        series_ids = {a["recurring_series_id"] for a in arr}
        assert len(series_ids) == 1
        assert None not in series_ids

    def test_list_appointments_filter(self, api_client, test_patient):
        r = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-06-01",
                "end": "2026-06-22",
                "patient_id": test_patient["id"],
            },
        )
        assert r.status_code == 200
        arr = r.json()
        assert len(arr) == 4

    def test_update_appointment_end_time_recomputes_amount(
        self, api_client, test_patient
    ):
        r = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-05-04",
                "end": "2026-05-04",
                "patient_id": test_patient["id"],
            },
        )
        appt = r.json()[0]
        rate = appt["hourly_rate"]
        r2 = api_client.put(
            f"{BASE_URL}/api/appointments/{appt['id']}",
            json={"end_time": "10:30"},
        )
        assert r2.status_code == 200
        u = r2.json()
        assert u["duration_minutes"] == 90
        assert u["amount"] == round(90 / 60.0 * rate, 2)

    def test_update_end_before_start_400(self, api_client, test_patient):
        r = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-05-04",
                "end": "2026-05-04",
                "patient_id": test_patient["id"],
            },
        )
        appt = r.json()[0]
        r2 = api_client.put(
            f"{BASE_URL}/api/appointments/{appt['id']}",
            json={"end_time": "08:00"},
        )
        assert r2.status_code == 400

    def test_update_series_scope_future(self, api_client, test_patient):
        r = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-06-08",
                "end": "2026-06-08",
                "patient_id": test_patient["id"],
            },
        )
        appt = r.json()[0]
        r2 = api_client.put(
            f"{BASE_URL}/api/appointments/{appt['id']}",
            json={"start_time": "10:00", "end_time": "11:30", "scope": "future"},
        )
        assert r2.status_code == 200
        # 08, 15, 22 should now be 90 min
        for d in ("2026-06-08", "2026-06-15", "2026-06-22"):
            arr = api_client.get(
                f"{BASE_URL}/api/appointments",
                params={"start": d, "end": d, "patient_id": test_patient["id"]},
            ).json()
            assert arr[0]["duration_minutes"] == 90
        # 01 unchanged (still 60)
        arr = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={"start": "2026-06-01", "end": "2026-06-01", "patient_id": test_patient["id"]},
        ).json()
        assert arr[0]["duration_minutes"] == 60

    def test_delete_series_scope(self, api_client, test_patient):
        arr = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-06-01",
                "end": "2026-06-22",
                "patient_id": test_patient["id"],
            },
        ).json()
        first = arr[0]
        r = api_client.delete(
            f"{BASE_URL}/api/appointments/{first['id']}",
            params={"scope": "series"},
        )
        assert r.status_code == 200
        arr2 = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-06-01",
                "end": "2026-06-22",
                "patient_id": test_patient["id"],
            },
        ).json()
        assert len(arr2) == 0


# ---------------------------------------------------------------------------
# Invoices — flow: create 7 sessions x 1.5h @ 50€ + 2€ = 527€
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def invoice_patient(api_client):
    payload = {
        "first_name": "TEST_Luca",
        "last_name": "TEST_Verdi",
        "codice_fiscale": "VRDLCU80A01H501Z",
        "address": "Via Fattura 3",
        "city": "Torino",
        "cap": "10100",
        "hcp_code": "HCP527",
    }
    r = api_client.post(f"{BASE_URL}/api/patients", json=payload)
    p = r.json()
    yield p
    # cleanup done by DB restart or leave — invoices block delete anyway


class TestInvoiceFlow:
    @pytest.fixture(autouse=True)
    def _ensure_rate_50(self, api_client):
        # Reset to standard 50€/h globally
        api_client.put(f"{BASE_URL}/api/settings", json={"hourly_rate": 50.0})

    def test_create_seven_sessions_march_2026(self, api_client, invoice_patient):
        # Create 7 sessions of 90 minutes each in March 2026
        base = date(2026, 3, 2)  # Monday
        for i in range(7):
            r = api_client.post(
                f"{BASE_URL}/api/appointments",
                json={
                    "patient_id": invoice_patient["id"],
                    "date": (date(2026, 3, 2 + i)).isoformat(),
                    "start_time": "09:00",
                    "end_time": "10:30",
                },
            )
            assert r.status_code == 200

    def test_preview_totals_527(self, api_client, invoice_patient):
        r = api_client.post(
            f"{BASE_URL}/api/invoices/preview",
            json={"patient_id": invoice_patient["id"], "year": 2026, "month": 3},
        )
        assert r.status_code == 200
        d = r.json()
        assert len(d["lines"]) == 7
        assert d["total_hours"] == 10.5
        assert d["imponibile"] == 525.0
        assert d["total"] == 527.0
        assert d["already_invoiced"] is False
        assert d["existing_invoice_id"] is None

    def test_preview_excludes_cancelled(self, api_client, invoice_patient):
        # Cancel one and re-check preview count decreases
        arr = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-03-02",
                "end": "2026-03-08",
                "patient_id": invoice_patient["id"],
            },
        ).json()
        appt_id = arr[0]["id"]
        r = api_client.put(
            f"{BASE_URL}/api/appointments/{appt_id}", json={"status": "cancelled"}
        )
        assert r.status_code == 200
        p = api_client.post(
            f"{BASE_URL}/api/invoices/preview",
            json={"patient_id": invoice_patient["id"], "year": 2026, "month": 3},
        ).json()
        assert len(p["lines"]) == 6
        # Restore
        api_client.put(
            f"{BASE_URL}/api/appointments/{appt_id}", json={"status": "scheduled"}
        )

    def test_preview_does_not_increment_number(self, api_client, invoice_patient):
        before = api_client.get(f"{BASE_URL}/api/settings").json()["next_invoice_number"]
        api_client.post(
            f"{BASE_URL}/api/invoices/preview",
            json={"patient_id": invoice_patient["id"], "year": 2026, "month": 3},
        )
        after = api_client.get(f"{BASE_URL}/api/settings").json()["next_invoice_number"]
        assert before == after

    def test_confirm_invoice_march_2026(self, api_client, invoice_patient):
        settings_before = api_client.get(f"{BASE_URL}/api/settings").json()
        num_before = settings_before["next_invoice_number"]
        r = api_client.post(
            f"{BASE_URL}/api/invoices/confirm",
            json={"patient_id": invoice_patient["id"], "year": 2026, "month": 3},
        )
        assert r.status_code == 200, r.text
        inv = r.json()
        assert inv["total"] == 527.0
        assert inv["imponibile"] == 525.0
        assert inv["number"] == num_before
        assert inv["number_full"] == f"{num_before}/HCP"
        assert len(inv["lines"]) == 7
        assert re.match(r"^[0-9a-f-]{36}$", inv["id"])
        assert "_id" not in inv
        # counter incremented
        after = api_client.get(f"{BASE_URL}/api/settings").json()["next_invoice_number"]
        assert after == num_before + 1
        # Appointments now blocked
        arr = api_client.get(
            f"{BASE_URL}/api/appointments",
            params={
                "start": "2026-03-01",
                "end": "2026-03-31",
                "patient_id": invoice_patient["id"],
            },
        ).json()
        assert all(a["invoice_id"] == inv["id"] for a in arr)
        # cannot modify invoiced appointment
        r2 = api_client.put(
            f"{BASE_URL}/api/appointments/{arr[0]['id']}", json={"end_time": "11:00"}
        )
        assert r2.status_code == 400
        # Store for later tests via module attr
        TestInvoiceFlow.invoice_id = inv["id"]
        TestInvoiceFlow.invoice_number_full = inv["number_full"]

    def test_confirm_duplicate_month_blocked(self, api_client, invoice_patient):
        r = api_client.post(
            f"{BASE_URL}/api/invoices/confirm",
            json={"patient_id": invoice_patient["id"], "year": 2026, "month": 3},
        )
        assert r.status_code == 400

    def test_get_invoice_and_list(self, api_client):
        inv_id = TestInvoiceFlow.invoice_id
        r = api_client.get(f"{BASE_URL}/api/invoices/{inv_id}")
        assert r.status_code == 200
        # list filter
        r2 = api_client.get(
            f"{BASE_URL}/api/invoices", params={"year": 2026, "month": 3}
        )
        assert r2.status_code == 200
        assert any(i["id"] == inv_id for i in r2.json())

    def test_download_xlsx_and_pdf(self, api_client):
        inv_id = TestInvoiceFlow.invoice_id
        rx = api_client.get(f"{BASE_URL}/api/invoices/{inv_id}/download", params={"fmt": "xlsx"})
        assert rx.status_code == 200
        assert rx.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        # Ensure it's a real xlsx (zip w/ xl/ dir)
        with zipfile.ZipFile(io.BytesIO(rx.content)) as z:
            assert any(name.startswith("xl/") for name in z.namelist())
        # Verify template cells
        wb = openpyxl.load_workbook(io.BytesIO(rx.content))
        ws = wb.active
        assert ws["A7"].value == "Fattura n"
        assert ws["B7"].value == TestInvoiceFlow.invoice_number_full
        # G7 uppercase patient name
        assert "TEST_VERDI" in str(ws["G7"].value).upper()
        assert ws["G8"].value == "VRDLCU80A01H501Z"
        # C11 contains "Pratica HCP 527"
        assert "HCP527" in str(ws["C11"].value)
        # Row 14: A=1.5 hours, C="Seduta fisioterapia"
        assert ws["A14"].value == 1.5
        assert ws["C14"].value == "Seduta fisioterapia"
        # G14 formula uses hourly_rate 50
        assert "=SUM(A14*50" in str(ws["G14"].value)
        # H14 esente
        assert ws["H14"].value == "esente"
        # H15 formula
        assert str(ws["H15"].value).startswith("=IF(G15,H$14,0)")
        # Bollo row 33: G33 = 2.0
        assert ws["G33"].value == 2.0
        # Imponibile row 34: =SUM(G14:G20)
        assert str(ws["G34"].value) == "=SUM(G14:G20)"
        # Totale row 36: =G34+G33
        assert "G34" in str(ws["G36"].value) and "G33" in str(ws["G36"].value)

        rp = api_client.get(f"{BASE_URL}/api/invoices/{inv_id}/download", params={"fmt": "pdf"})
        assert rp.status_code == 200
        assert rp.headers["content-type"] == "application/pdf"
        assert rp.content[:4] == b"%PDF"

    def test_patient_history_contains_march(self, api_client, invoice_patient):
        r = api_client.get(f"{BASE_URL}/api/patients/{invoice_patient['id']}/history")
        assert r.status_code == 200
        d = r.json()
        y = next((y for y in d["years"] if y["year"] == 2026), None)
        assert y is not None
        m = next((m for m in y["months"] if m["month"] == 3), None)
        assert m is not None
        assert m["invoice_id"] is not None
        assert m["invoice_number_full"] == TestInvoiceFlow.invoice_number_full

    def test_patient_month_history_contains_invoice(self, api_client, invoice_patient):
        r = api_client.get(
            f"{BASE_URL}/api/patients/{invoice_patient['id']}/history/2026/3"
        )
        assert r.status_code == 200
        d = r.json()
        assert d["invoice"] is not None
        assert d["invoice"]["number_full"] == TestInvoiceFlow.invoice_number_full
        assert len(d["appointments"]) == 7

    def test_delete_patient_blocked_by_invoice(self, api_client, invoice_patient):
        r = api_client.delete(f"{BASE_URL}/api/patients/{invoice_patient['id']}")
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Voice
# ---------------------------------------------------------------------------
class TestVoice:
    def test_transcribe_without_file_returns_4xx(self, api_client):
        r = requests.post(f"{BASE_URL}/api/voice/transcribe")
        assert 400 <= r.status_code < 500

    def test_voice_plan_create_appointment(self, api_client):
        # Need a target patient that AI can match by name
        p = api_client.post(
            f"{BASE_URL}/api/patients",
            json={"first_name": "Giulia", "last_name": "Ferrari"},
        ).json()
        try:
            r = api_client.post(
                f"{BASE_URL}/api/voice/plan",
                json={
                    "text": "Domani alle 9 metti Giulia Ferrari per un'ora e mezza",
                    "today": "2026-07-15",
                },
                timeout=60,
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert "actions" in d
            assert isinstance(d["actions"], list) and len(d["actions"]) >= 1
            # Look for a create_appointment action
            create_actions = [a for a in d["actions"] if a.get("op") == "create_appointment"]
            assert create_actions, f"Expected create_appointment. Got: {d['actions']}"
            # Look for results & at least one ok success
            assert any(res.get("ok") for res in d.get("results", []))
        finally:
            # Cleanup created appointments and patient
            appts = api_client.get(
                f"{BASE_URL}/api/appointments",
                params={"patient_id": p["id"]},
            ).json()
            for a in appts:
                api_client.delete(f"{BASE_URL}/api/appointments/{a['id']}")
            api_client.delete(f"{BASE_URL}/api/patients/{p['id']}")
