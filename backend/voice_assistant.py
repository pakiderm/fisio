"""AI voice assistant: transcribe audio + parse Italian scheduling commands into
structured actions, then execute them against the appointments/patients data."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from emergentintegrations.llm.chat import LlmChat, UserMessage
from emergentintegrations.llm.openai import OpenAISpeechToText
from fastapi import HTTPException, UploadFile
from pydantic import BaseModel

load_dotenv()

LLM_KEY = os.getenv("EMERGENT_LLM_KEY")

logger = logging.getLogger(__name__)


class VoicePlanRequest(BaseModel):
    text: str
    today: Optional[str] = None  # YYYY-MM-DD


class VoicePlanResponse(BaseModel):
    text: str
    understood: str  # what the AI understood
    actions: list[dict[str, Any]]
    results: list[dict[str, Any]]


ITALIAN_WEEKDAYS = {
    "lunedi": 0,
    "lunedì": 0,
    "martedi": 1,
    "martedì": 1,
    "mercoledi": 2,
    "mercoledì": 2,
    "giovedi": 3,
    "giovedì": 3,
    "venerdi": 4,
    "venerdì": 4,
    "sabato": 5,
    "domenica": 6,
}


# ---------------------------------------------------------------------------
# Speech-to-Text
# ---------------------------------------------------------------------------


async def transcribe_audio(upload: UploadFile) -> str:
    if not LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY non configurata")
    # Save to a temp file — the STT client needs a real file handle.
    suffix = Path(upload.filename or "audio.m4a").suffix or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await upload.read())
        tmp_path = tmp.name
    try:
        stt = OpenAISpeechToText(api_key=LLM_KEY)
        with open(tmp_path, "rb") as f:
            resp = await stt.transcribe(
                file=f,
                model="gpt-4o-mini-transcribe",
                response_format="json",
                language="it",
                temperature=0.0,
            )
        return (getattr(resp, "text", "") or "").strip()
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# LLM planning
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = """Sei l'assistente di un fisioterapista italiano. L'utente dà comandi vocali in italiano per gestire il suo calendario di appuntamenti.

Il tuo compito: convertire il testo dell'utente in un JSON strutturato con le azioni da eseguire. Rispondi SOLO con JSON valido, senza spiegazioni fuori dal JSON.

Formato di risposta OBBLIGATORIO:
{
  "understood": "riassunto in italiano di ciò che l'utente vuole",
  "actions": [ ... array di azioni ... ]
}

Azioni disponibili:

1. create_appointment — crea una terapia
   {"op":"create_appointment", "patient": "Nome Cognome", "date":"YYYY-MM-DD", "start":"HH:MM", "end":"HH:MM"}
   - "patient" è il nome del paziente come detto dall'utente (verrà cercato per fuzzy match).
   - Se l'utente dice solo la durata (es. "un'ora e mezza"), calcola "end" da "start" + durata.
   - Se manca l'ora, chiedi (metti nell'output un warning), ma prova sempre a proporre.

2. cancel_appointment — cancella una terapia (mette lo stato "cancelled")
   {"op":"cancel_appointment", "date":"YYYY-MM-DD", "start":"HH:MM"?, "patient":"..."?}
   - Deve essere sufficiente a identificare univocamente l'appuntamento.

3. delete_appointment — elimina definitivamente
   {"op":"delete_appointment", "date":"YYYY-MM-DD", "start":"HH:MM"?, "patient":"..."?}

4. copy_week — replica gli appuntamenti di una settimana verso un'altra
   {"op":"copy_week", "from_week_start":"YYYY-MM-DD", "to_week_start":"YYYY-MM-DD"}
   - Le date sono il lunedì di ciascuna settimana.

5. set_status — cambia lo stato di un appuntamento (completed | cancelled | scheduled)
   {"op":"set_status", "date":"YYYY-MM-DD", "start":"HH:MM"?, "patient":"..."?, "status":"completed"}

Regole per le date:
- La data di oggi è %TODAY% (giorno %WEEKDAY%).
- "domani" = oggi + 1 giorno.
- "dopodomani" = oggi + 2 giorni.
- "lunedì prossimo" / "prossimo lunedì" = primo lunedì che viene dopo oggi.
- "martedì" senza qualificatori = il prossimo martedì (se oggi è martedì, oggi stesso solo se detto "oggi").
- "la settimana prossima" = il lunedì della settimana successiva a quella corrente.
- Ora "9" o "le 9" = 09:00; "9 e mezza" o "9:30" = 09:30.

Se il comando non è chiaro o mancano dati critici, includi comunque le azioni migliori possibili e spiega nel campo "understood" cosa hai dedotto.

Restituisci SOLO il JSON, nulla altro.
"""


def _format_weekday(d: date) -> str:
    names = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
    return names[d.weekday()]


async def plan_from_text(text: str, today: Optional[str]) -> dict:
    if not LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY non configurata")
    tdate = date.fromisoformat(today) if today else date.today()
    system = SYSTEM_PROMPT.replace("%TODAY%", tdate.isoformat()).replace(
        "%WEEKDAY%", _format_weekday(tdate)
    )
    chat = LlmChat(
        api_key=LLM_KEY,
        session_id=f"voice-{uuid.uuid4()}",
        system_message=system,
    ).with_model("openai", "gpt-5.4")
    resp = await chat.send_message(UserMessage(text=text))
    raw = getattr(resp, "text", None) or (resp if isinstance(resp, str) else str(resp))
    # Extract JSON block if the model wrapped it in prose
    json_str = _extract_json(raw)
    try:
        parsed = json.loads(json_str)
    except Exception as e:
        logger.error("Failed to parse LLM output: %s\n%s", e, raw)
        raise HTTPException(422, f"Impossibile interpretare il comando: {raw[:200]}")
    if not isinstance(parsed, dict) or "actions" not in parsed:
        raise HTTPException(422, "Comando non riconosciuto")
    return parsed


def _extract_json(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        # strip code fences
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    # Try to find the outermost {...}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    return m.group(0) if m else raw


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------


def _minutes(start: str, end: str) -> int:
    h1, m1 = map(int, start.split(":"))
    h2, m2 = map(int, end.split(":"))
    return (h2 * 60 + m2) - (h1 * 60 + m1)


def _norm_name(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


async def _find_patient(db, user_id: str, name: str) -> Optional[dict]:
    if not name:
        return None
    name = _norm_name(name)
    docs = await db.patients.find({"user_id": user_id}, {"_id": 0, "user_id": 0}).to_list(2000)
    # Exact
    for p in docs:
        full = _norm_name(f"{p['first_name']} {p['last_name']}")
        full2 = _norm_name(f"{p['last_name']} {p['first_name']}")
        if name in (full, full2):
            return p
    # Partial: last name
    for p in docs:
        if _norm_name(p["last_name"]) in name or name in _norm_name(p["last_name"]):
            return p
    # Partial: first name
    for p in docs:
        if _norm_name(p["first_name"]) in name or name in _norm_name(p["first_name"]):
            return p
    return None


async def _find_appointment(
    db, user_id: str, when_date: str, start: Optional[str], patient_id: Optional[str]
) -> Optional[dict]:
    q: dict[str, Any] = {"user_id": user_id, "date": when_date}
    if start:
        q["start_time"] = start
    if patient_id:
        q["patient_id"] = patient_id
    docs = await db.appointments.find(q, {"_id": 0}).to_list(20)
    if docs:
        return docs[0]
    if start:
        q2: dict[str, Any] = {"user_id": user_id, "date": when_date}
        if patient_id:
            q2["patient_id"] = patient_id
        return await db.appointments.find_one(q2, {"_id": 0})
    return None


async def execute_actions(db, actions: list[dict], settings: dict, user_id: str) -> list[dict]:
    from calendar import monthrange  # noqa

    results = []
    hourly_rate_default = float(settings.get("hourly_rate", 50.0))

    for a in actions:
        op = a.get("op")
        try:
            if op == "create_appointment":
                pname = a.get("patient", "")
                p = await _find_patient(db, user_id, pname)
                if not p:
                    results.append({"ok": False, "op": op, "error": f"Paziente non trovato: {pname}"})
                    continue
                d_iso = a.get("date")
                start = a.get("start")
                end = a.get("end")
                if not d_iso or not start or not end:
                    results.append({"ok": False, "op": op, "error": "Data/ora mancanti"})
                    continue
                dur = _minutes(start, end)
                if dur <= 0:
                    results.append({"ok": False, "op": op, "error": "Durata non valida"})
                    continue
                rate = p.get("custom_hourly_rate") or hourly_rate_default
                appt = {
                    "id": str(uuid.uuid4()),
                    "user_id": user_id,
                    "patient_id": p["id"],
                    "date": d_iso,
                    "start_time": start,
                    "end_time": end,
                    "duration_minutes": dur,
                    "hourly_rate": rate,
                    "amount": round(dur / 60.0 * rate, 2),
                    "status": "scheduled",
                    "notes": "",
                    "recurring_series_id": None,
                    "invoice_id": None,
                    "created_at": datetime.utcnow(),
                }
                await db.appointments.insert_one(appt)
                appt.pop("_id", None)
                appt.pop("user_id", None)
                appt["created_at"] = appt["created_at"].isoformat() + "Z"
                results.append({
                    "ok": True,
                    "op": op,
                    "summary": f"Creata terapia: {p['first_name']} {p['last_name']} il {d_iso} {start}-{end}",
                    "appointment": appt,
                })
            elif op in ("cancel_appointment", "delete_appointment", "set_status"):
                pname = a.get("patient", "")
                p = await _find_patient(db, user_id, pname) if pname else None
                appt = await _find_appointment(
                    db, user_id, a.get("date", ""), a.get("start"), p["id"] if p else None
                )
                if not appt:
                    results.append({"ok": False, "op": op, "error": "Appuntamento non trovato"})
                    continue
                if op == "cancel_appointment":
                    await db.appointments.update_one(
                        {"id": appt["id"], "user_id": user_id}, {"$set": {"status": "cancelled"}}
                    )
                    results.append({
                        "ok": True,
                        "op": op,
                        "summary": f"Annullata terapia del {appt['date']} {appt['start_time']}",
                    })
                elif op == "delete_appointment":
                    if appt.get("invoice_id"):
                        results.append({
                            "ok": False,
                            "op": op,
                            "error": "Non elimino: già fatturata",
                        })
                        continue
                    await db.appointments.delete_one({"id": appt["id"], "user_id": user_id})
                    results.append({
                        "ok": True,
                        "op": op,
                        "summary": f"Eliminata terapia del {appt['date']} {appt['start_time']}",
                    })
                else:  # set_status
                    status = a.get("status", "scheduled")
                    if status not in {"scheduled", "completed", "cancelled"}:
                        status = "scheduled"
                    await db.appointments.update_one(
                        {"id": appt["id"], "user_id": user_id}, {"$set": {"status": status}}
                    )
                    results.append({
                        "ok": True,
                        "op": op,
                        "summary": f"Stato aggiornato a {status} per {appt['date']} {appt['start_time']}",
                    })
            elif op == "copy_week":
                fw = a.get("from_week_start")
                tw = a.get("to_week_start")
                if not fw or not tw:
                    results.append({"ok": False, "op": op, "error": "Settimane mancanti"})
                    continue
                fw_d = date.fromisoformat(fw)
                tw_d = date.fromisoformat(tw)
                delta = (tw_d - fw_d).days
                fw_end = (fw_d + timedelta(days=6)).isoformat()
                src = await db.appointments.find(
                    {
                        "user_id": user_id,
                        "date": {"$gte": fw, "$lte": fw_end},
                        "status": {"$ne": "cancelled"},
                    },
                    {"_id": 0},
                ).to_list(200)
                created = 0
                for s in src:
                    new_date = (date.fromisoformat(s["date"]) + timedelta(days=delta)).isoformat()
                    exists = await db.appointments.find_one({
                        "user_id": user_id,
                        "patient_id": s["patient_id"],
                        "date": new_date,
                        "start_time": s["start_time"],
                    })
                    if exists:
                        continue
                    new_appt = {
                        **s,
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "date": new_date,
                        "status": "scheduled",
                        "recurring_series_id": None,
                        "invoice_id": None,
                        "created_at": datetime.utcnow(),
                    }
                    await db.appointments.insert_one(new_appt)
                    created += 1
                results.append({
                    "ok": True,
                    "op": op,
                    "summary": f"Copiata settimana {fw} → {tw}: {created} terapie",
                })
            else:
                results.append({"ok": False, "op": op or "?", "error": "Operazione non supportata"})
        except Exception as e:
            logger.exception("Voice action failed")
            results.append({"ok": False, "op": op or "?", "error": str(e)})
    return results
