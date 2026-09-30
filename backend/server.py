"""FisioManager backend — physiotherapist appointment & invoice management.

All business endpoints are scoped by the authenticated user (`user_id`).
Authentication supports email+password, Emergent Google Auth, and Apple Sign-in.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, List, Literal, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from auth import build_auth_router, make_current_user_dep
from invoice_generator import (
    ITALIAN_MONTHS,
    OUTPUT_DIR,
    generate_pdf,
    generate_xlsx,
)
from voice_assistant import (
    VoicePlanRequest,
    VoicePlanResponse,
    execute_actions,
    plan_from_text,
    transcribe_audio,
)


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="FisioManager")
api = APIRouter(prefix="/api")
current_user_dep = make_current_user_dep(db)
CurrentUser = Annotated[dict, Depends(current_user_dep)]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


AppointmentStatus = Literal["scheduled", "completed", "cancelled"]


class Professional(BaseModel):
    name: str = "dr. Mauro Reielli"
    address: str = "Via Claudio Guerdile, 10"
    phone: str = "3482348896"
    email: str = "reiellim@gmail.com"
    vat: str = "06268110654"


class Settings(BaseModel):
    id: str
    hourly_rate: float = 50.0
    next_invoice_number: int = 1
    invoice_suffix: str = "/HCP"
    stamp_duty: float = 2.0
    professional: Professional = Field(default_factory=Professional)


class SettingsUpdate(BaseModel):
    hourly_rate: Optional[float] = None
    next_invoice_number: Optional[int] = None
    invoice_suffix: Optional[str] = None
    stamp_duty: Optional[float] = None
    professional: Optional[Professional] = None


class Patient(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    first_name: str
    last_name: str
    codice_fiscale: str = ""
    address: str = ""
    city: str = ""
    cap: str = ""
    hcp_code: str = ""
    custom_hourly_rate: Optional[float] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PatientCreate(BaseModel):
    first_name: str
    last_name: str
    codice_fiscale: str = ""
    address: str = ""
    city: str = ""
    cap: str = ""
    hcp_code: str = ""
    custom_hourly_rate: Optional[float] = None


class PatientUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    codice_fiscale: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    cap: Optional[str] = None
    hcp_code: Optional[str] = None
    custom_hourly_rate: Optional[float] = None


class Appointment(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    patient_id: str
    date: str
    start_time: str
    end_time: str
    duration_minutes: int
    hourly_rate: float
    amount: float
    status: AppointmentStatus = "scheduled"
    notes: str = ""
    recurring_series_id: Optional[str] = None
    invoice_id: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AppointmentCreate(BaseModel):
    patient_id: str
    date: str
    start_time: str
    end_time: str
    status: AppointmentStatus = "scheduled"
    notes: str = ""
    recurring: bool = False
    recurring_until: Optional[str] = None
    recurring_frequency: Literal["weekly", "biweekly", "monthly"] = "weekly"


class AppointmentUpdate(BaseModel):
    patient_id: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    status: Optional[AppointmentStatus] = None
    notes: Optional[str] = None
    scope: Literal["single", "future", "series"] = "single"


class InvoiceLine(BaseModel):
    appointment_id: str
    date: str
    start_time: str
    end_time: str
    duration_minutes: int
    amount: float


class Invoice(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    number: int
    suffix: str
    number_full: str
    patient_id: str
    patient_snapshot: dict
    professional_snapshot: dict
    hourly_rate: float
    stamp_duty: float
    year: int
    month: int
    issue_date: str
    imponibile: float
    total: float
    lines: List[InvoiceLine]
    xlsx_path: str
    pdf_path: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class InvoicePreviewRequest(BaseModel):
    patient_id: str
    year: int
    month: int


class InvoiceConfirmRequest(BaseModel):
    patient_id: str
    year: int
    month: int
    issue_date: Optional[str] = None  # YYYY-MM-DD; defaults to today


class InvoicePreviewResponse(BaseModel):
    patient: Patient
    year: int
    month: int
    month_label: str
    next_invoice_number_full: str
    hourly_rate: float
    stamp_duty: float
    lines: List[InvoiceLine]
    total_hours: float
    imponibile: float
    total: float
    already_invoiced: bool
    existing_invoice_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _minutes_between(start: str, end: str) -> int:
    h1, m1 = map(int, start.split(":"))
    h2, m2 = map(int, end.split(":"))
    return (h2 * 60 + m2) - (h1 * 60 + m1)


async def _get_settings(user_id: str) -> Settings:
    doc = await db.settings.find_one({"id": user_id}, {"_id": 0})
    if not doc:
        settings = Settings(id=user_id)
        await db.settings.insert_one(settings.model_dump())
        return settings
    return Settings(**doc)


async def _get_patient(user_id: str, patient_id: str) -> Patient:
    doc = await db.patients.find_one(
        {"id": patient_id, "user_id": user_id}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Paziente non trovato")
    return Patient(**doc)


def _effective_hourly_rate(patient: Patient, settings: Settings) -> float:
    if patient.custom_hourly_rate is not None and patient.custom_hourly_rate > 0:
        return patient.custom_hourly_rate
    return settings.hourly_rate


# ---------------------------------------------------------------------------
# Settings endpoints
# ---------------------------------------------------------------------------


@api.get("/settings", response_model=Settings)
async def get_settings(user: CurrentUser):
    return await _get_settings(user["id"])


@api.put("/settings", response_model=Settings)
async def update_settings(payload: SettingsUpdate, user: CurrentUser):
    current = await _get_settings(user["id"])
    data = current.model_dump()
    upd = payload.model_dump(exclude_unset=True)
    if "professional" in upd and upd["professional"] is not None:
        data["professional"] = {**data["professional"], **upd["professional"]}
        upd.pop("professional")
    data.update(upd)
    data["id"] = user["id"]
    await db.settings.update_one({"id": user["id"]}, {"$set": data}, upsert=True)
    return Settings(**data)


# ---------------------------------------------------------------------------
# Patients
# ---------------------------------------------------------------------------


@api.get("/patients", response_model=List[Patient])
async def list_patients(user: CurrentUser, q: Optional[str] = None):
    query: dict = {"user_id": user["id"]}
    if q:
        query["$or"] = [
            {"first_name": {"$regex": q, "$options": "i"}},
            {"last_name": {"$regex": q, "$options": "i"}},
            {"codice_fiscale": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.patients.find(query, {"_id": 0, "user_id": 0}).sort(
        [("last_name", 1), ("first_name", 1)]
    )
    return [Patient(**d) for d in await cursor.to_list(2000)]


@api.post("/patients", response_model=Patient)
async def create_patient(payload: PatientCreate, user: CurrentUser):
    patient = Patient(**payload.model_dump())
    doc = {**patient.model_dump(), "user_id": user["id"]}
    await db.patients.insert_one(doc)
    return patient


@api.get("/patients/{patient_id}", response_model=Patient)
async def get_patient(patient_id: str, user: CurrentUser):
    return await _get_patient(user["id"], patient_id)


@api.put("/patients/{patient_id}", response_model=Patient)
async def update_patient(patient_id: str, payload: PatientUpdate, user: CurrentUser):
    upd = payload.model_dump(exclude_unset=True)
    if not upd:
        return await _get_patient(user["id"], patient_id)
    r = await db.patients.update_one(
        {"id": patient_id, "user_id": user["id"]}, {"$set": upd}
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Paziente non trovato")
    return await _get_patient(user["id"], patient_id)


@api.delete("/patients/{patient_id}")
async def delete_patient(patient_id: str, user: CurrentUser):
    inv = await db.invoices.find_one({"patient_id": patient_id, "user_id": user["id"]})
    if inv:
        raise HTTPException(
            status_code=400,
            detail="Impossibile eliminare: esistono fatture associate a questo paziente",
        )
    await db.appointments.delete_many(
        {"patient_id": patient_id, "user_id": user["id"]}
    )
    r = await db.patients.delete_one({"id": patient_id, "user_id": user["id"]})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Paziente non trovato")
    return {"ok": True}


class PatientImportRow(BaseModel):
    first_name: str
    last_name: str
    codice_fiscale: str = ""
    address: str = ""
    city: str = ""
    cap: str = ""
    hcp_code: str = ""
    custom_hourly_rate: Optional[float] = None


class PatientImportRequest(BaseModel):
    patients: List[PatientImportRow]


@api.post("/patients/import")
async def import_patients(payload: PatientImportRequest, user: CurrentUser):
    created = 0
    for row in payload.patients:
        p = Patient(**row.model_dump())
        await db.patients.insert_one({**p.model_dump(), "user_id": user["id"]})
        created += 1
    return {"imported": created}


@api.get("/patients/{patient_id}/history")
async def patient_history(patient_id: str, user: CurrentUser):
    await _get_patient(user["id"], patient_id)
    cursor = db.appointments.find(
        {
            "patient_id": patient_id,
            "user_id": user["id"],
            "status": {"$ne": "cancelled"},
        },
        {"_id": 0, "user_id": 0},
    )
    apps = await cursor.to_list(10000)
    tree: dict[int, dict[int, dict]] = {}
    for a in apps:
        y = int(a["date"][:4])
        m = int(a["date"][5:7])
        tree.setdefault(y, {}).setdefault(m, {"count": 0, "hours": 0.0, "amount": 0.0})
        tree[y][m]["count"] += 1
        tree[y][m]["hours"] += a["duration_minutes"] / 60.0
        tree[y][m]["amount"] += a["amount"]
    invs = await db.invoices.find(
        {"patient_id": patient_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    ).to_list(1000)
    inv_map: dict[tuple[int, int], dict] = {(i["year"], i["month"]): i for i in invs}
    years = []
    for y in sorted(tree.keys(), reverse=True):
        months = []
        for m in sorted(tree[y].keys(), reverse=True):
            item = tree[y][m]
            inv = inv_map.get((y, m))
            months.append(
                {
                    "month": m,
                    "month_label": ITALIAN_MONTHS[m - 1],
                    "count": item["count"],
                    "hours": round(item["hours"], 2),
                    "amount": round(item["amount"], 2),
                    "invoice_id": inv["id"] if inv else None,
                    "invoice_number_full": inv["number_full"] if inv else None,
                }
            )
        years.append({"year": y, "months": months})
    total_count = sum(m["count"] for y in years for m in y["months"])
    total_hours = sum(m["hours"] for y in years for m in y["months"])
    total_amount = sum(m["amount"] for y in years for m in y["months"])
    return {
        "years": years,
        "totals": {
            "count": total_count,
            "hours": round(total_hours, 2),
            "amount": round(total_amount, 2),
        },
    }


@api.get("/patients/{patient_id}/history/{year}/{month}")
async def patient_month_history(
    patient_id: str, year: int, month: int, user: CurrentUser
):
    await _get_patient(user["id"], patient_id)
    start = f"{year:04d}-{month:02d}-01"
    if month == 12:
        end = f"{year+1:04d}-01-01"
    else:
        end = f"{year:04d}-{month+1:02d}-01"
    cursor = db.appointments.find(
        {
            "patient_id": patient_id,
            "user_id": user["id"],
            "date": {"$gte": start, "$lt": end},
        },
        {"_id": 0, "user_id": 0},
    ).sort("date", 1)
    apps = await cursor.to_list(10000)
    inv = await db.invoices.find_one(
        {
            "patient_id": patient_id,
            "user_id": user["id"],
            "year": year,
            "month": month,
        },
        {"_id": 0, "user_id": 0},
    )
    return {"appointments": apps, "invoice": inv}


# ---------------------------------------------------------------------------
# Appointments
# ---------------------------------------------------------------------------


@api.get("/appointments", response_model=List[Appointment])
async def list_appointments(
    user: CurrentUser,
    start: Optional[str] = None,
    end: Optional[str] = None,
    patient_id: Optional[str] = None,
):
    query: dict[str, Any] = {"user_id": user["id"]}
    if start and end:
        query["date"] = {"$gte": start, "$lte": end}
    elif start:
        query["date"] = {"$gte": start}
    elif end:
        query["date"] = {"$lte": end}
    if patient_id:
        query["patient_id"] = patient_id
    cursor = db.appointments.find(query, {"_id": 0, "user_id": 0}).sort(
        [("date", 1), ("start_time", 1)]
    )
    docs = await cursor.to_list(5000)
    return [Appointment(**d) for d in docs]


@api.post("/appointments", response_model=List[Appointment])
async def create_appointment(payload: AppointmentCreate, user: CurrentUser):
    patient = await _get_patient(user["id"], payload.patient_id)
    settings = await _get_settings(user["id"])
    rate = _effective_hourly_rate(patient, settings)
    dur = _minutes_between(payload.start_time, payload.end_time)
    if dur <= 0:
        raise HTTPException(status_code=400, detail="Ora di fine deve essere dopo l'ora di inizio")

    dates: List[str] = [payload.date]
    series_id: Optional[str] = None
    if payload.recurring:
        if not payload.recurring_until:
            raise HTTPException(status_code=400, detail="Data fine ricorrenza mancante")
        series_id = str(uuid.uuid4())
        d = datetime.fromisoformat(payload.date).date()
        end = datetime.fromisoformat(payload.recurring_until).date()
        step = {"weekly": 7, "biweekly": 14, "monthly": 30}[payload.recurring_frequency]
        cur = d
        dates = []
        while cur <= end:
            dates.append(cur.isoformat())
            if payload.recurring_frequency == "monthly":
                y, m = cur.year, cur.month + 1
                if m > 12:
                    m = 1
                    y += 1
                try:
                    cur = cur.replace(year=y, month=m)
                except ValueError:
                    from calendar import monthrange
                    last = monthrange(y, m)[1]
                    cur = date(y, m, last)
            else:
                cur = cur + timedelta(days=step)

    created: List[Appointment] = []
    for d_iso in dates:
        appt = Appointment(
            patient_id=payload.patient_id,
            date=d_iso,
            start_time=payload.start_time,
            end_time=payload.end_time,
            duration_minutes=dur,
            hourly_rate=rate,
            amount=round(dur / 60.0 * rate, 2),
            status=payload.status,
            notes=payload.notes,
            recurring_series_id=series_id,
        )
        await db.appointments.insert_one({**appt.model_dump(), "user_id": user["id"]})
        created.append(appt)
    return created


@api.get("/appointments/{appointment_id}", response_model=Appointment)
async def get_appointment(appointment_id: str, user: CurrentUser):
    doc = await db.appointments.find_one(
        {"id": appointment_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Appuntamento non trovato")
    return Appointment(**doc)


@api.put("/appointments/{appointment_id}")
async def update_appointment(
    appointment_id: str, payload: AppointmentUpdate, user: CurrentUser
):
    doc = await db.appointments.find_one(
        {"id": appointment_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Appuntamento non trovato")
    if doc.get("invoice_id"):
        raise HTTPException(
            status_code=400, detail="Impossibile modificare: appuntamento già fatturato"
        )

    upd_raw = payload.model_dump(exclude_unset=True)
    scope = upd_raw.pop("scope", "single")
    upd: dict[str, Any] = dict(upd_raw)

    if upd.get("patient_id"):
        patient = await _get_patient(user["id"], upd["patient_id"])
        settings = await _get_settings(user["id"])
        upd["hourly_rate"] = _effective_hourly_rate(patient, settings)
    if upd.get("start_time") or upd.get("end_time"):
        st = upd.get("start_time", doc["start_time"])
        et = upd.get("end_time", doc["end_time"])
        dur = _minutes_between(st, et)
        if dur <= 0:
            raise HTTPException(status_code=400, detail="Ora di fine deve essere dopo l'ora di inizio")
        upd["duration_minutes"] = dur
        rate = upd.get("hourly_rate", doc["hourly_rate"])
        upd["amount"] = round(dur / 60.0 * rate, 2)
    elif "hourly_rate" in upd:
        upd["amount"] = round(doc["duration_minutes"] / 60.0 * upd["hourly_rate"], 2)

    base_filter = {"user_id": user["id"], "invoice_id": None}
    if scope == "single" or not doc.get("recurring_series_id"):
        await db.appointments.update_one(
            {**base_filter, "id": appointment_id}, {"$set": upd}
        )
    elif scope == "future":
        await db.appointments.update_many(
            {
                **base_filter,
                "recurring_series_id": doc["recurring_series_id"],
                "date": {"$gte": doc["date"]},
            },
            {"$set": upd},
        )
    elif scope == "series":
        await db.appointments.update_many(
            {**base_filter, "recurring_series_id": doc["recurring_series_id"]},
            {"$set": upd},
        )

    updated = await db.appointments.find_one(
        {"id": appointment_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    return Appointment(**updated)


@api.delete("/appointments/{appointment_id}")
async def delete_appointment(
    appointment_id: str,
    user: CurrentUser,
    scope: Literal["single", "future", "series"] = "single",
):
    doc = await db.appointments.find_one(
        {"id": appointment_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Appuntamento non trovato")
    if doc.get("invoice_id"):
        raise HTTPException(
            status_code=400, detail="Impossibile eliminare: appuntamento già fatturato"
        )
    base = {"user_id": user["id"], "invoice_id": None}
    if scope == "single" or not doc.get("recurring_series_id"):
        await db.appointments.delete_one({**base, "id": appointment_id})
    elif scope == "future":
        await db.appointments.delete_many(
            {
                **base,
                "recurring_series_id": doc["recurring_series_id"],
                "date": {"$gte": doc["date"]},
            }
        )
    elif scope == "series":
        await db.appointments.delete_many(
            {**base, "recurring_series_id": doc["recurring_series_id"]}
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------


async def _month_appointments(user_id: str, patient_id: str, year: int, month: int) -> List[dict]:
    start = f"{year:04d}-{month:02d}-01"
    if month == 12:
        end = f"{year+1:04d}-01-01"
    else:
        end = f"{year:04d}-{month+1:02d}-01"
    cursor = db.appointments.find(
        {
            "patient_id": patient_id,
            "user_id": user_id,
            "date": {"$gte": start, "$lt": end},
            "status": {"$ne": "cancelled"},
        },
        {"_id": 0, "user_id": 0},
    ).sort([("date", 1), ("start_time", 1)])
    return await cursor.to_list(2000)


@api.post("/invoices/preview", response_model=InvoicePreviewResponse)
async def invoice_preview(payload: InvoicePreviewRequest, user: CurrentUser):
    patient = await _get_patient(user["id"], payload.patient_id)
    settings = await _get_settings(user["id"])
    apps = await _month_appointments(
        user["id"], payload.patient_id, payload.year, payload.month
    )
    lines = [
        InvoiceLine(
            appointment_id=a["id"],
            date=a["date"],
            start_time=a["start_time"],
            end_time=a["end_time"],
            duration_minutes=a["duration_minutes"],
            amount=a["amount"],
        )
        for a in apps
    ]
    imponibile = round(sum(l.amount for l in lines), 2)
    total = round(imponibile + settings.stamp_duty, 2)
    total_hours = round(sum(l.duration_minutes for l in lines) / 60.0, 2)
    existing = await db.invoices.find_one(
        {
            "patient_id": payload.patient_id,
            "user_id": user["id"],
            "year": payload.year,
            "month": payload.month,
        },
        {"_id": 0, "user_id": 0},
    )
    return InvoicePreviewResponse(
        patient=patient,
        year=payload.year,
        month=payload.month,
        month_label=ITALIAN_MONTHS[payload.month - 1],
        next_invoice_number_full=f"{settings.next_invoice_number}{settings.invoice_suffix}",
        hourly_rate=_effective_hourly_rate(patient, settings),
        stamp_duty=settings.stamp_duty,
        lines=lines,
        total_hours=total_hours,
        imponibile=imponibile,
        total=total,
        already_invoiced=existing is not None,
        existing_invoice_id=existing["id"] if existing else None,
    )


@api.post("/invoices/confirm", response_model=Invoice)
async def invoice_confirm(payload: InvoiceConfirmRequest, user: CurrentUser):
    patient = await _get_patient(user["id"], payload.patient_id)
    settings = await _get_settings(user["id"])
    existing = await db.invoices.find_one(
        {
            "patient_id": payload.patient_id,
            "user_id": user["id"],
            "year": payload.year,
            "month": payload.month,
        }
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Fattura {existing['number_full']} già emessa per questo mese",
        )
    apps = await _month_appointments(
        user["id"], payload.patient_id, payload.year, payload.month
    )
    if not apps:
        raise HTTPException(status_code=400, detail="Nessuna prestazione fatturabile in questo mese")

    number = settings.next_invoice_number
    # scoped duplicate check on this user's invoices
    while await db.invoices.find_one({"number": number, "user_id": user["id"]}):
        number += 1

    number_full = f"{number}{settings.invoice_suffix}"
    rate = _effective_hourly_rate(patient, settings)

    lines = [
        InvoiceLine(
            appointment_id=a["id"],
            date=a["date"],
            start_time=a["start_time"],
            end_time=a["end_time"],
            duration_minutes=a["duration_minutes"],
            amount=a["amount"],
        )
        for a in apps
    ]
    imponibile = round(sum(l.amount for l in lines), 2)
    total = round(imponibile + settings.stamp_duty, 2)

    if payload.issue_date is not None and payload.issue_date != "":
        try:
            issue_date = date.fromisoformat(payload.issue_date)
        except ValueError:
            raise HTTPException(400, "Data di emissione non valida")
    else:
        issue_date = date.today()

    invoice = Invoice(
        number=number,
        suffix=settings.invoice_suffix,
        number_full=number_full,
        patient_id=patient.id,
        patient_snapshot=patient.model_dump(),
        professional_snapshot=settings.professional.model_dump(),
        hourly_rate=rate,
        stamp_duty=settings.stamp_duty,
        year=payload.year,
        month=payload.month,
        issue_date=issue_date.isoformat(),
        imponibile=imponibile,
        total=total,
        lines=lines,
        xlsx_path="",
        pdf_path="",
    )

    safe_last = "".join(c for c in patient.last_name if c.isalnum()) or "paziente"
    base = f"{user['id']}_fattura_{number}_{safe_last}_{payload.year}_{payload.month:02d}"
    xlsx_path = OUTPUT_DIR / f"{base}.xlsx"
    pdf_path = OUTPUT_DIR / f"{base}.pdf"

    generate_xlsx(
        invoice_number_full=number_full,
        invoice_date=issue_date,
        patient=patient.model_dump(),
        professional=settings.professional.model_dump(),
        appointments=apps,
        stamp_duty=settings.stamp_duty,
        hourly_rate=rate,
        out_path=xlsx_path,
    )
    generate_pdf(
        invoice_number_full=number_full,
        invoice_date=issue_date,
        patient=patient.model_dump(),
        professional=settings.professional.model_dump(),
        appointments=apps,
        stamp_duty=settings.stamp_duty,
        hourly_rate=rate,
        out_path=pdf_path,
    )

    invoice.xlsx_path = str(xlsx_path)
    invoice.pdf_path = str(pdf_path)

    await db.invoices.insert_one({**invoice.model_dump(), "user_id": user["id"]})
    for a in apps:
        await db.appointments.update_one(
            {"id": a["id"], "user_id": user["id"]},
            {"$set": {"invoice_id": invoice.id}},
        )
    await db.settings.update_one(
        {"id": user["id"]},
        {"$set": {"next_invoice_number": number + 1}},
        upsert=True,
    )
    return invoice


@api.get("/invoices", response_model=List[Invoice])
async def list_invoices(
    user: CurrentUser,
    year: Optional[int] = None,
    month: Optional[int] = None,
    patient_id: Optional[str] = None,
    number: Optional[int] = None,
):
    q: dict = {"user_id": user["id"]}
    if year is not None:
        q["year"] = year
    if month is not None:
        q["month"] = month
    if patient_id:
        q["patient_id"] = patient_id
    if number is not None:
        q["number"] = number
    cursor = db.invoices.find(q, {"_id": 0, "user_id": 0}).sort(
        [("year", -1), ("month", -1), ("number", -1)]
    )
    docs = await cursor.to_list(1000)
    return [Invoice(**d) for d in docs]


@api.get("/invoices/{invoice_id}", response_model=Invoice)
async def get_invoice(invoice_id: str, user: CurrentUser):
    doc = await db.invoices.find_one(
        {"id": invoice_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Fattura non trovata")
    return Invoice(**doc)


@api.get("/invoices/{invoice_id}/download")
async def download_invoice(
    invoice_id: str, user: CurrentUser, fmt: Literal["xlsx", "pdf"] = "xlsx"
):
    doc = await db.invoices.find_one(
        {"id": invoice_id, "user_id": user["id"]}, {"_id": 0, "user_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Fattura non trovata")
    path = doc["xlsx_path"] if fmt == "xlsx" else doc["pdf_path"]
    if not path or not Path(path).exists():
        raise HTTPException(status_code=404, detail=f"File {fmt} non disponibile")
    filename = f"fattura_{doc['number']}{doc['suffix'].replace('/', '_')}.{fmt}"
    if fmt == "xlsx":
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        media = "application/pdf"
    return FileResponse(path, media_type=media, filename=filename)


# ---------------------------------------------------------------------------
# Voice assistant
# ---------------------------------------------------------------------------


@api.post("/voice/transcribe")
async def voice_transcribe(user: CurrentUser, audio: UploadFile = File(...)):
    text = await transcribe_audio(audio)
    return {"text": text}


@api.post("/voice/plan", response_model=VoicePlanResponse)
async def voice_plan(payload: VoicePlanRequest, user: CurrentUser):
    settings = await _get_settings(user["id"])
    plan = await plan_from_text(payload.text, payload.today)
    actions = plan.get("actions", [])
    results = await execute_actions(db, actions, settings.model_dump(), user_id=user["id"])
    return VoicePlanResponse(
        text=payload.text,
        understood=plan.get("understood", ""),
        actions=actions,
        results=results,
    )


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------


app.include_router(api)
app.include_router(build_auth_router(db), prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True, sparse=True)
    await db.users.create_index("id", unique=True)
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.patients.create_index([("user_id", 1), ("last_name", 1)])
    await db.appointments.create_index(
        [("user_id", 1), ("date", 1), ("patient_id", 1)]
    )
    await db.invoices.create_index([("user_id", 1), ("number", 1)], unique=True)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
