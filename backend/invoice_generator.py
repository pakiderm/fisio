"""Excel and PDF invoice generation from the physiotherapist template."""

from __future__ import annotations

import os
from copy import copy
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.lib import colors as rl_colors


BACKEND_ROOT = Path(__file__).parent
TEMPLATE_PATH = BACKEND_ROOT / "templates" / "invoice_template.xlsx"
OUTPUT_DIR = BACKEND_ROOT / "invoices_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


ITALIAN_MONTHS = [
    "Gennaio",
    "Febbraio",
    "Marzo",
    "Aprile",
    "Maggio",
    "Giugno",
    "Luglio",
    "Agosto",
    "Settembre",
    "Ottobre",
    "Novembre",
    "Dicembre",
]


def _format_date(d) -> str:
    if isinstance(d, str):
        try:
            d = datetime.fromisoformat(d).date()
        except Exception:
            return d
    if isinstance(d, datetime):
        d = d.date()
    return d.strftime("%d/%m/%Y")


def _copy_row_styles(ws, src_row: int, dst_row: int) -> None:
    """Copy cell styles + row height from src_row to dst_row for columns A..H."""
    for col in range(1, 9):
        src = ws.cell(row=src_row, column=col)
        dst = ws.cell(row=dst_row, column=col)
        if src.has_style:
            dst.font = copy(src.font)
            dst.fill = copy(src.fill)
            dst.border = copy(src.border)
            dst.alignment = copy(src.alignment)
            dst.number_format = src.number_format
            dst.protection = copy(src.protection)
    # Row height
    src_rd = ws.row_dimensions.get(src_row)
    if src_rd and src_rd.height:
        ws.row_dimensions[dst_row].height = src_rd.height


def generate_xlsx(
    invoice_number_full: str,
    invoice_date: date,
    patient: dict,
    professional: dict,
    appointments: List[dict],
    stamp_duty: float,
    hourly_rate: float,
    out_path: Path,
) -> Path:
    """Generate an .xlsx invoice from the template, faithfully."""
    wb = openpyxl.load_workbook(TEMPLATE_PATH)
    ws = wb.active

    # --- Professional header (A1..A4) ---
    ws["A1"] = professional.get("name", "")
    ws["A2"] = professional.get("address", "")
    tel = professional.get("phone", "")
    email = professional.get("email", "")
    ws["A3"] = f"Tel. {tel}  E-mail {email}".strip()
    piva = professional.get("vat", "")
    ws["A4"] = f"Partita Iva {piva}" if piva else ""

    # --- Invoice header row 7 ---
    ws["A7"] = "Fattura n"
    ws["B7"] = invoice_number_full  # e.g. "52/HCP"
    patient_name_upper = f"{patient.get('last_name','').upper()} {patient.get('first_name','').upper()}".strip()
    ws["G7"] = patient_name_upper

    # --- Row 8: 'del' <date>, 'Cliente', codice fiscale ---
    ws["A8"] = "del"
    ws["B8"] = invoice_date
    ws["B8"].number_format = "dd/mm/yyyy"
    ws["E8"] = "Cliente"
    ws["G8"] = patient.get("codice_fiscale", "")

    # Row 9: patient full name, address
    ws["E9"] = f"{patient.get('first_name','')} {patient.get('last_name','')}".strip()
    ws["G9"] = patient.get("address", "")

    # Row 10: city (+ CAP if present)
    city = patient.get("city", "") or ""
    cap = patient.get("cap", "") or ""
    ws["G10"] = f"{cap} {city}".strip()

    # Row 11: Pratica HCP
    hcp = patient.get("hcp_code", "")
    ws["C11"] = f"Pratica HCP {hcp}" if hcp else "Pratica HCP"

    # --- Detail rows (start at 14) ---
    # Template comes with rows 14..20 pre-styled. We must (a) fill in only the
    # actual appointments, (b) clear the leftover pre-filled rows, and (c)
    # keep the same style. If we have more than 7 appointments, we add rows
    # copying the style of row 14.

    DETAIL_START = 14
    TEMPLATE_LAST_DETAIL = 20  # rows 14..20 are pre-styled in the template
    # Also A21..A23 have 1.5 values that need clearing.
    TEMPLATE_A_LAST = 23

    appts_sorted = sorted(appointments, key=lambda a: (a["date"], a["start_time"]))
    n = len(appts_sorted)

    # If more appointments than pre-styled rows, we need to insert new rows
    # BEFORE the summary block (row 31+). openpyxl insert_rows keeps formulas
    # in cells below shifted, but formulas that reference rows above are not
    # auto-adjusted. Our summary formulas will be rewritten anyway.
    end_detail_row = DETAIL_START + max(n, TEMPLATE_LAST_DETAIL - DETAIL_START + 1) - 1
    if n > (TEMPLATE_LAST_DETAIL - DETAIL_START + 1):
        extra = n - (TEMPLATE_LAST_DETAIL - DETAIL_START + 1)
        # Insert `extra` rows AFTER row TEMPLATE_LAST_DETAIL (before summary at row 31)
        ws.insert_rows(TEMPLATE_LAST_DETAIL + 1, amount=extra)
        # Copy styles from row 20 (a "regular" IF row) to new rows
        for i in range(extra):
            _copy_row_styles(ws, TEMPLATE_LAST_DETAIL, TEMPLATE_LAST_DETAIL + 1 + i)
            # Extend the merged C:F range to the new row
            new_row = TEMPLATE_LAST_DETAIL + 1 + i
            ws.merge_cells(start_row=new_row, start_column=3, end_row=new_row, end_column=6)

    # Fill in each appointment row
    for idx, ap in enumerate(appts_sorted):
        row = DETAIL_START + idx
        hours = ap["duration_minutes"] / 60.0
        ap_date = ap["date"]
        if isinstance(ap_date, str):
            ap_date = datetime.fromisoformat(ap_date).date()
        ws.cell(row=row, column=1, value=hours)  # A: hours
        ws.cell(row=row, column=1).number_format = "0.##"
        ws.cell(row=row, column=2, value=ap_date)  # B: date
        ws.cell(row=row, column=2).number_format = "dd/mm/yyyy"
        ws.cell(row=row, column=3, value="Seduta fisioterapia")  # C (merged C:F)
        # G: importo — keep formula using hourly rate (usa la tariffa del paziente/globale)
        ws.cell(row=row, column=7, value=f"=SUM(A{row}*{hourly_rate})")
        ws.cell(row=row, column=7).number_format = '#,##0.00 "€"'
        # H: "esente" for first, IF for others
        if idx == 0:
            ws.cell(row=row, column=8, value="esente")
        else:
            ws.cell(row=row, column=8, value=f"=IF(G{row},H$14,0)")

    # Clear leftover template rows (from n .. TEMPLATE_LAST_DETAIL) if n < 7.
    # Skip MergedCell instances (they are read-only, the top-left of the merge holds
    # the value and we cleared it via the "master" cell reference above).
    from openpyxl.cell.cell import MergedCell as _MergedCell
    for row in range(DETAIL_START + n, TEMPLATE_LAST_DETAIL + 1):
        for col in range(1, 9):
            cell = ws.cell(row=row, column=col)
            if isinstance(cell, _MergedCell):
                continue
            cell.value = None

    # Also clear A21..A23 that come with 1.5 in template
    for row in range(TEMPLATE_LAST_DETAIL + 1, TEMPLATE_A_LAST + 1):
        # Only clear if we did not insert extra rows there
        if row > end_detail_row:
            cell = ws.cell(row=row, column=1)
            if not isinstance(cell, _MergedCell):
                cell.value = None

    # --- Recompute summary rows ---
    # After potential inserts, the summary block original rows (31..36) have shifted.
    # openpyxl.insert_rows shifts cells below down, so labels are preserved but
    # formulas need updating.
    inserted = max(0, n - (TEMPLATE_LAST_DETAIL - DETAIL_START + 1))
    row_disclaim1 = 31 + inserted
    row_disclaim2 = 32 + inserted
    row_bollo = 33 + inserted
    row_impon = 34 + inserted
    row_iva = 35 + inserted
    row_totale = 36 + inserted

    # Detail range for SUM
    detail_last = DETAIL_START + n - 1 if n > 0 else DETAIL_START
    # Bollo value
    ws.cell(row=row_bollo, column=7, value=float(stamp_duty))
    ws.cell(row=row_bollo, column=7).number_format = '#,##0.00 "€"'

    # Imponibile = SUM(G14:G<detail_last>)
    ws.cell(row=row_impon, column=7, value=f"=SUM(G{DETAIL_START}:G{detail_last})")
    ws.cell(row=row_impon, column=7).number_format = '#,##0.00 "€"'

    # Iva esente (retains the "esente" text from H14)
    ws.cell(row=row_iva, column=7, value=f"=H{DETAIL_START}")

    # Totale = Imponibile + Bollo
    ws.cell(row=row_totale, column=7, value=f"=G{row_impon}+G{row_bollo}")
    ws.cell(row=row_totale, column=7).number_format = '#,##0.00 "€"'

    wb.save(out_path)
    return out_path


def generate_pdf(
    invoice_number_full: str,
    invoice_date: date,
    patient: dict,
    professional: dict,
    appointments: List[dict],
    stamp_duty: float,
    hourly_rate: float,
    out_path: Path,
) -> Path:
    """Generate a PDF invoice replicating the Excel layout."""
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=A4,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )
    styles = getSampleStyleSheet()
    normal = ParagraphStyle("n", parent=styles["Normal"], fontName="Helvetica", fontSize=10, leading=13)
    small = ParagraphStyle("s", parent=styles["Normal"], fontName="Helvetica", fontSize=9, leading=12)
    header_big = ParagraphStyle(
        "hb", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=14, leading=18, alignment=1
    )
    header = ParagraphStyle(
        "h", parent=styles["Normal"], fontName="Helvetica", fontSize=10, leading=13, alignment=1
    )
    bold = ParagraphStyle("b", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=13)

    story = []
    # Professional header (centered like Excel merged A1:H1..A4:H4)
    story.append(Paragraph(professional.get("name", ""), header_big))
    story.append(Paragraph(professional.get("address", ""), header))
    story.append(
        Paragraph(
            f"Tel. {professional.get('phone','')}  E-mail {professional.get('email','')}",
            header,
        )
    )
    piva = professional.get("vat", "")
    story.append(Paragraph(f"Partita Iva {piva}" if piva else "", header))
    story.append(Spacer(1, 12))

    # Invoice number + patient block
    patient_name_upper = (
        f"{patient.get('last_name','').upper()} {patient.get('first_name','').upper()}".strip()
    )
    inv_table = Table(
        [
            [
                Paragraph(f"<b>Fattura n</b> {invoice_number_full}", normal),
                "",
                Paragraph(f"<b>{patient_name_upper}</b>", normal),
            ],
            [
                Paragraph(f"del {_format_date(invoice_date)}", normal),
                Paragraph("Cliente", normal),
                Paragraph(patient.get("codice_fiscale", ""), normal),
            ],
            [
                "",
                Paragraph(
                    f"{patient.get('first_name','')} {patient.get('last_name','')}", normal
                ),
                Paragraph(patient.get("address", ""), normal),
            ],
            [
                "",
                "",
                Paragraph(
                    f"{patient.get('cap','') or ''} {patient.get('city','') or ''}".strip(),
                    normal,
                ),
            ],
        ],
        colWidths=[5 * cm, 4 * cm, 8 * cm],
    )
    inv_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(inv_table)
    story.append(Spacer(1, 8))

    hcp = patient.get("hcp_code", "")
    story.append(Paragraph(f"<b>Pratica HCP</b> {hcp}", normal))
    story.append(Spacer(1, 10))

    # Detail table
    header_row = ["Ore", "Data", "Descrizione", "Importo", "Iva"]
    rows = [header_row]
    imponibile = 0.0
    appts_sorted = sorted(appointments, key=lambda a: (a["date"], a["start_time"]))
    for idx, ap in enumerate(appts_sorted):
        hours = ap["duration_minutes"] / 60.0
        amount = hours * hourly_rate
        imponibile += amount
        rows.append(
            [
                f"{hours:.2f}".rstrip("0").rstrip("."),
                _format_date(ap["date"]),
                "Seduta fisioterapia",
                f"{amount:,.2f} €".replace(",", "X").replace(".", ",").replace("X", "."),
                "esente" if idx == 0 else "esente",
            ]
        )
    detail = Table(rows, colWidths=[1.7 * cm, 2.6 * cm, 8.5 * cm, 3 * cm, 1.8 * cm])
    detail.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 10),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("ALIGN", (1, 0), (1, -1), "CENTER"),
                ("ALIGN", (3, 0), (3, -1), "RIGHT"),
                ("ALIGN", (4, 0), (4, -1), "CENTER"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, rl_colors.black),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(detail)
    story.append(Spacer(1, 12))

    totale = imponibile + stamp_duty

    def _euro(v: float) -> str:
        return f"{v:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")

    tot_rows = [
        ["", "Bollo", _euro(stamp_duty)],
        ["Imponibile", "Imponibile", _euro(imponibile)],
        ["Iva", "Iva esente", "esente"],
        ["Totale fattura", "TOTALE FATTURA", _euro(totale)],
    ]
    tot = Table(tot_rows, colWidths=[5 * cm, 6 * cm, 4.5 * cm])
    tot.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), "Helvetica", 10),
                ("FONT", (0, 3), (-1, 3), "Helvetica-Bold", 11),
                ("ALIGN", (2, 0), (2, -1), "RIGHT"),
                ("LINEABOVE", (0, 3), (-1, 3), 0.5, rl_colors.black),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(tot)
    story.append(Spacer(1, 14))

    story.append(
        Paragraph(
            "La presente fattura è esente dall'Imposta sul Valore aggiunto "
            "ai sensi dell'art. 10, c. 1, n. 18) D.P.R. 633/72",
            small,
        )
    )

    doc.build(story)
    return out_path
