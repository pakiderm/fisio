import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import {
  MONTHS_IT,
  addDays,
  euro,
  fmtDayLong,
  fromISODate,
  toISODate,
} from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { Appointment, AppointmentStatus, Patient, Settings } from "@/src/types";

const HOUR_SLOTS = Array.from({ length: 14 * 2 }, (_, i) => {
  const total = 8 * 60 + i * 30; // 08:00 -> 21:30
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
});

const DURATION_MIN_OPTIONS = [30, 45, 60, 75, 90, 120];

export default function AppointmentFormScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; date?: string }>();
  const isEdit = !!(params.id && params.id !== "nuovo");
  const qc = useQueryClient();

  const patientsQ = useQuery({
    queryKey: ["patients"],
    queryFn: () => api.get<Patient[]>("/patients"),
  });
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });
  const apptQ = useQuery({
    queryKey: ["appointment", params.id],
    queryFn: () => api.get<Appointment>(`/appointments/${params.id}`),
    enabled: isEdit,
  });

  const [patientId, setPatientId] = useState<string>("");
  const [date, setDate] = useState<string>(params.date || toISODate(new Date()));
  const [startTime, setStartTime] = useState<string>("09:00");
  const [endTime, setEndTime] = useState<string>("10:00");
  const [status, setStatus] = useState<AppointmentStatus>("scheduled");
  const [notes, setNotes] = useState<string>("");
  const [recurring, setRecurring] = useState<boolean>(false);
  const [recurringUntil, setRecurringUntil] = useState<string>("");
  const [recurringFreq, setRecurringFreq] = useState<"weekly" | "biweekly" | "monthly">("weekly");
  const [showPatientPicker, setShowPatientPicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState<null | "date" | "recurring-until">(null);
  const [patientSearch, setPatientSearch] = useState("");
  const [editScope, setEditScope] = useState<"single" | "future" | "series">("single");
  const [showScopePicker, setShowScopePicker] = useState<null | "save" | "delete">(null);

  useEffect(() => {
    if (isEdit && apptQ.data) {
      setPatientId(apptQ.data.patient_id);
      setDate(apptQ.data.date);
      setStartTime(apptQ.data.start_time);
      setEndTime(apptQ.data.end_time);
      setStatus(apptQ.data.status);
      setNotes(apptQ.data.notes || "");
    }
  }, [apptQ.data, isEdit]);

  const patient = useMemo(
    () => (patientsQ.data ?? []).find((p) => p.id === patientId),
    [patientsQ.data, patientId],
  );
  const rate = patient?.custom_hourly_rate ?? settingsQ.data?.hourly_rate ?? 50;

  const durationMin = useMemo(() => {
    const [h1, m1] = startTime.split(":").map(Number);
    const [h2, m2] = endTime.split(":").map(Number);
    return h2 * 60 + m2 - (h1 * 60 + m1);
  }, [startTime, endTime]);
  const amount = Math.round((durationMin / 60) * rate * 100) / 100;

  const setDuration = (min: number) => {
    const [h, m] = startTime.split(":").map(Number);
    const total = h * 60 + m + min;
    const eh = Math.floor(total / 60) % 24;
    const em = total % 60;
    setEndTime(`${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`);
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Appointment[]>("/appointments", {
        patient_id: patientId,
        date,
        start_time: startTime,
        end_time: endTime,
        status,
        notes,
        recurring,
        recurring_until: recurring ? recurringUntil : undefined,
        recurring_frequency: recurringFreq,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      router.back();
    },
  });

  const update = useMutation({
    mutationFn: (scope: "single" | "future" | "series") =>
      api.put<Appointment>(`/appointments/${params.id}`, {
        patient_id: patientId,
        date,
        start_time: startTime,
        end_time: endTime,
        status,
        notes,
        scope,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      router.back();
    },
  });

  const del = useMutation({
    mutationFn: (scope: "single" | "future" | "series") =>
      api.delete(`/appointments/${params.id}`, { scope }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      router.back();
    },
  });

  const canSave = !!patientId && durationMin > 0 && (!recurring || !!recurringUntil);

  const handleSave = () => {
    if (!canSave) return;
    if (isEdit && apptQ.data?.recurring_series_id) {
      setShowScopePicker("save");
    } else if (isEdit) {
      update.mutate("single");
    } else {
      create.mutate();
    }
  };

  const handleDelete = () => {
    if (!isEdit) return;
    if (apptQ.data?.recurring_series_id) {
      setShowScopePicker("delete");
    } else {
      del.mutate("single");
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} testID="cancel-btn">
          <Text style={styles.cancelText}>Annulla</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{isEdit ? "Modifica terapia" : "Nuova terapia"}</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave || create.isPending || update.isPending}
          testID="save-btn"
        >
          <Text style={[styles.saveText, !canSave && { opacity: 0.4 }]}>Salva</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 200 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Patient */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Paziente</Text>
          <TouchableOpacity
            onPress={() => setShowPatientPicker(true)}
            style={styles.picker}
            testID="select-patient"
          >
            <Text style={patient ? styles.pickerText : styles.pickerPlaceholder}>
              {patient ? `${patient.last_name} ${patient.first_name}` : "Seleziona paziente"}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>

        {/* Date */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Data</Text>
          <TouchableOpacity
            onPress={() => setShowDatePicker("date")}
            style={styles.picker}
            testID="select-date"
          >
            <Text style={styles.pickerText}>{fmtDayLong(fromISODate(date))}</Text>
            <Ionicons name="calendar" size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>

        {/* Times */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Orario</Text>
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>Inizio</Text>
              <HScroll
                selected={startTime}
                items={HOUR_SLOTS}
                onSelect={(t) => {
                  setStartTime(t);
                  // Keep duration
                  if (durationMin > 0) {
                    const [h, m] = t.split(":").map(Number);
                    const total = h * 60 + m + durationMin;
                    const eh = Math.floor(total / 60) % 24;
                    const em = total % 60;
                    setEndTime(`${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`);
                  }
                }}
                testIDPrefix="start"
              />
            </View>
          </View>
          <View style={{ marginTop: spacing.md }}>
            <Text style={styles.smallLabel}>Fine</Text>
            <HScroll
              selected={endTime}
              items={HOUR_SLOTS}
              onSelect={setEndTime}
              testIDPrefix="end"
            />
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: spacing.md, flexWrap: "wrap" }}>
            {DURATION_MIN_OPTIONS.map((d) => (
              <TouchableOpacity
                key={d}
                testID={`dur-${d}`}
                onPress={() => setDuration(d)}
                style={[styles.chip, durationMin === d && styles.chipActive]}
              >
                <Text
                  style={[
                    styles.chipText,
                    durationMin === d && { color: colors.onBrandPrimary, fontWeight: "700" },
                  ]}
                >
                  {d}m
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Live calc */}
        <View style={styles.liveCalc} testID="live-calc">
          <View style={{ flex: 1 }}>
            <Text style={styles.calcLabel}>Durata</Text>
            <Text style={styles.calcValue}>
              {durationMin > 0 ? `${durationMin} min` : "—"}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.calcLabel}>Tariffa</Text>
            <Text style={styles.calcValue}>{euro(rate)}/h</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.calcLabel}>Importo</Text>
            <Text
              style={[styles.calcValue, { color: colors.brandPrimary, fontWeight: "800" }]}
            >
              {durationMin > 0 ? euro(amount) : "—"}
            </Text>
          </View>
        </View>

        {/* Status */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Stato</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {(["scheduled", "completed", "cancelled"] as AppointmentStatus[]).map((s) => (
              <TouchableOpacity
                key={s}
                testID={`status-${s}`}
                onPress={() => setStatus(s)}
                style={[styles.chip, status === s && styles.chipActive]}
              >
                <Text
                  style={[
                    styles.chipText,
                    status === s && { color: colors.onBrandPrimary, fontWeight: "700" },
                  ]}
                >
                  {s === "scheduled" ? "Programmato" : s === "completed" ? "Effettuato" : "Annullato"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Note</Text>
          <TextInput
            testID="notes-input"
            value={notes}
            onChangeText={setNotes}
            placeholder="Note opzionali"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]}
            multiline
          />
        </View>

        {/* Recurring — only on create */}
        {!isEdit && (
          <View style={styles.section}>
            <TouchableOpacity
              onPress={() => setRecurring(!recurring)}
              testID="recurring-toggle"
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <View
                style={[
                  styles.checkbox,
                  recurring && {
                    backgroundColor: colors.brandPrimary,
                    borderColor: colors.brandPrimary,
                  },
                ]}
              >
                {recurring && (
                  <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />
                )}
              </View>
              <Text style={styles.sectionLabel}>Appuntamento ricorrente</Text>
            </TouchableOpacity>
            {recurring && (
              <View style={{ marginTop: spacing.md, gap: spacing.md }}>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {(["weekly", "biweekly", "monthly"] as const).map((f) => (
                    <TouchableOpacity
                      key={f}
                      testID={`freq-${f}`}
                      onPress={() => setRecurringFreq(f)}
                      style={[styles.chip, recurringFreq === f && styles.chipActive]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          recurringFreq === f && {
                            color: colors.onBrandPrimary,
                            fontWeight: "700",
                          },
                        ]}
                      >
                        {f === "weekly"
                          ? "Settimanale"
                          : f === "biweekly"
                            ? "Ogni 2 sett."
                            : "Mensile"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity
                  onPress={() => setShowDatePicker("recurring-until")}
                  style={styles.picker}
                  testID="select-recurring-until"
                >
                  <Text style={recurringUntil ? styles.pickerText : styles.pickerPlaceholder}>
                    {recurringUntil ? `Fino al ${fmtDayLong(fromISODate(recurringUntil))}` : "Data fine ricorrenza"}
                  </Text>
                  <Ionicons name="calendar" size={18} color={colors.muted} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {isEdit && (
          <TouchableOpacity
            testID="delete-appointment"
            onPress={handleDelete}
            style={styles.deleteBtn}
          >
            <Ionicons name="trash" size={18} color={colors.error} />
            <Text style={styles.deleteText}>Elimina terapia</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Patient picker modal */}
      <Modal visible={showPatientPicker} animationType="slide" onRequestClose={() => setShowPatientPicker(false)}>
        <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.surface }}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setShowPatientPicker(false)}>
              <Text style={styles.cancelText}>Chiudi</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Scegli paziente</Text>
            <View style={{ width: 60 }} />
          </View>
          <View style={{ padding: spacing.lg }}>
            <TextInput
              testID="patient-picker-search"
              value={patientSearch}
              onChangeText={setPatientSearch}
              placeholder="Cerca paziente"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: 8 }}>
            {(patientsQ.data ?? [])
              .filter((p) => {
                const s = patientSearch.trim().toLowerCase();
                if (!s) return true;
                return (
                  p.first_name.toLowerCase().includes(s) ||
                  p.last_name.toLowerCase().includes(s)
                );
              })
              .map((p) => (
                <TouchableOpacity
                  key={p.id}
                  testID={`pick-patient-${p.id}`}
                  onPress={() => {
                    setPatientId(p.id);
                    setShowPatientPicker(false);
                  }}
                  style={styles.pickRow}
                >
                  <Text style={styles.pickText}>
                    {p.last_name} {p.first_name}
                  </Text>
                  {p.id === patientId && (
                    <Ionicons name="checkmark" size={20} color={colors.brandPrimary} />
                  )}
                </TouchableOpacity>
              ))}
          </ScrollView>
        </View>
      </Modal>

      {/* Simple date scroller modal */}
      {showDatePicker && (
        <DateScrollerModal
          initial={showDatePicker === "date" ? date : recurringUntil || date}
          onCancel={() => setShowDatePicker(null)}
          onSelect={(v) => {
            if (showDatePicker === "date") setDate(v);
            else setRecurringUntil(v);
            setShowDatePicker(null);
          }}
        />
      )}

      {/* Scope picker for recurring edits */}
      <Modal visible={!!showScopePicker} transparent animationType="fade" onRequestClose={() => setShowScopePicker(null)}>
        <View style={styles.backdrop}>
          <View style={styles.scopeCard}>
            <Text style={styles.scopeTitle}>
              {showScopePicker === "delete" ? "Elimina" : "Modifica"} come...
            </Text>
            {[
              { k: "single" as const, label: "Solo questa terapia" },
              { k: "future" as const, label: "Questa e le successive" },
              { k: "series" as const, label: "Tutta la serie" },
            ].map((o) => (
              <TouchableOpacity
                key={o.k}
                testID={`scope-${o.k}`}
                onPress={() => {
                  if (showScopePicker === "delete") del.mutate(o.k);
                  else update.mutate(o.k);
                  setShowScopePicker(null);
                }}
                style={styles.scopeBtn}
              >
                <Text style={styles.scopeBtnText}>{o.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={() => setShowScopePicker(null)}
              style={[styles.scopeBtn, { marginTop: 4 }]}
            >
              <Text style={[styles.scopeBtnText, { color: colors.muted }]}>Annulla</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function HScroll({
  items,
  selected,
  onSelect,
  testIDPrefix,
}: {
  items: string[];
  selected: string;
  onSelect: (v: string) => void;
  testIDPrefix: string;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {items.map((t) => (
        <TouchableOpacity
          key={t}
          testID={`${testIDPrefix}-${t}`}
          onPress={() => onSelect(t)}
          style={[styles.chip, selected === t && styles.chipActive]}
        >
          <Text
            style={[
              styles.chipText,
              selected === t && { color: colors.onBrandPrimary, fontWeight: "700" },
            ]}
          >
            {t}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function DateScrollerModal({
  initial,
  onSelect,
  onCancel,
}: {
  initial: string;
  onSelect: (iso: string) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const init = fromISODate(initial);
  const [year, setYear] = useState(init.getFullYear());
  const [month, setMonth] = useState(init.getMonth());
  const [day, setDay] = useState(init.getDate());
  const daysIn = new Date(year, month + 1, 0).getDate();
  const years = Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - 2 + i);
  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.datePickerCard, { paddingBottom: insets.bottom + 16 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
            <TouchableOpacity onPress={onCancel}>
              <Text style={styles.cancelText}>Annulla</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Scegli data</Text>
            <TouchableOpacity
              testID="date-confirm"
              onPress={() => {
                const d = Math.min(day, daysIn);
                onSelect(
                  `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
                );
              }}
            >
              <Text style={styles.saveText}>OK</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <ColumnPicker
              testIDPrefix="pick-day"
              values={Array.from({ length: daysIn }, (_, i) => i + 1)}
              selected={day}
              onSelect={setDay}
              format={(v) => String(v)}
            />
            <ColumnPicker
              testIDPrefix="pick-month"
              values={MONTHS_IT.map((_, i) => i)}
              selected={month}
              onSelect={setMonth}
              format={(v) => MONTHS_IT[v]}
            />
            <ColumnPicker
              testIDPrefix="pick-year"
              values={years}
              selected={year}
              onSelect={setYear}
              format={(v) => String(v)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ColumnPicker<T>({
  values,
  selected,
  onSelect,
  format,
  testIDPrefix,
}: {
  values: T[];
  selected: T;
  onSelect: (v: T) => void;
  format: (v: T) => string;
  testIDPrefix: string;
}) {
  return (
    <View style={{ flex: 1, height: 200, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md }}>
      <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
        {values.map((v, i) => (
          <TouchableOpacity
            key={i}
            testID={`${testIDPrefix}-${String(v)}`}
            onPress={() => onSelect(v)}
            style={{
              paddingVertical: 8,
              alignItems: "center",
              backgroundColor:
                String(selected) === String(v) ? colors.brandTertiary : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 15,
                color: String(selected) === String(v) ? colors.brandPrimary : colors.onSurface,
                fontWeight: String(selected) === String(v) ? "700" : "400",
              }}
            >
              {format(v)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.onSurface },
  cancelText: { color: colors.muted, fontSize: 16 },
  saveText: { color: colors.brandPrimary, fontWeight: "700", fontSize: 16 },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  sectionLabel: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  smallLabel: { fontSize: 11, color: colors.muted, marginBottom: 6 },
  picker: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  pickerText: { color: colors.onSurface, fontSize: 15 },
  pickerPlaceholder: { color: colors.muted, fontSize: 15 },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.onSurface,
  },
  chip: {
    height: 36,
    minWidth: 60,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chipActive: { backgroundColor: colors.brandPrimary },
  chipText: { color: colors.onSurface, fontSize: 13 },
  liveCalc: {
    flexDirection: "row",
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  calcLabel: { color: colors.muted, fontSize: 11 },
  calcValue: { color: colors.onSurface, fontSize: 16, fontWeight: "700", marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
  },
  pickText: { color: colors.onSurface, fontSize: 15, fontWeight: "600" },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    marginTop: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.error,
  },
  deleteText: { color: colors.error, fontWeight: "700" },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  datePickerCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  scopeCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 8,
  },
  scopeTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
    marginBottom: 6,
  },
  scopeBtn: {
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
  },
  scopeBtnText: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
});
