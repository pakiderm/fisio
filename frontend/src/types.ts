export type AppointmentStatus = "scheduled" | "completed" | "cancelled";

export interface Professional {
  name: string;
  address: string;
  phone: string;
  email: string;
  vat: string;
}

export interface Settings {
  id: string;
  hourly_rate: number;
  next_invoice_number: number;
  invoice_suffix: string;
  stamp_duty: number;
  professional: Professional;
}

export interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  codice_fiscale: string;
  address: string;
  city: string;
  cap: string;
  hcp_code: string;
  custom_hourly_rate: number | null;
  created_at?: string;
}

export interface Appointment {
  id: string;
  patient_id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  hourly_rate: number;
  amount: number;
  status: AppointmentStatus;
  notes: string;
  recurring_series_id: string | null;
  invoice_id: string | null;
}

export interface InvoiceLine {
  appointment_id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  amount: number;
}

export interface Invoice {
  id: string;
  number: number;
  suffix: string;
  number_full: string;
  patient_id: string;
  patient_snapshot: Patient;
  professional_snapshot: Professional;
  hourly_rate: number;
  stamp_duty: number;
  year: number;
  month: number;
  issue_date: string;
  imponibile: number;
  total: number;
  lines: InvoiceLine[];
  xlsx_path: string;
  pdf_path: string;
}

export interface HistoryMonth {
  month: number;
  month_label: string;
  count: number;
  hours: number;
  amount: number;
  invoice_id: string | null;
  invoice_number_full: string | null;
}

export interface HistoryYear {
  year: number;
  months: HistoryMonth[];
}

export interface History {
  years: HistoryYear[];
  totals: { count: number; hours: number; amount: number };
}

export interface InvoicePreview {
  patient: Patient;
  year: number;
  month: number;
  month_label: string;
  next_invoice_number_full: string;
  hourly_rate: number;
  stamp_duty: number;
  lines: InvoiceLine[];
  total_hours: number;
  imponibile: number;
  total: number;
  already_invoiced: boolean;
  existing_invoice_id: string | null;
}
