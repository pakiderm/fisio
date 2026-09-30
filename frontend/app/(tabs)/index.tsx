import Ionicons from "@react-native-vector-icons/ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { VoiceAssistant } from "@/src/components/voice-assistant";
import {
  MONTHS_IT,
  WEEKDAYS_SHORT,
  addDays,
  endOfMonth,
  euro,
  fmtDayLong,
  fromISODate,
  minutesToText,
  startOfMonth,
  startOfWeek,
  toISODate,
} from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { Appointment, Patient } from "@/src/types";

type ViewMode = "day" | "week" | "month";

const STATUS_META: Record<
  Appointment["status"],
  { color: string; bg: string; label: string }
> = {
  scheduled: { color: colors.onBrandSecondary, bg: colors.brandSecondary, label: "Programmato" },
  completed: { color: colors.onSuccess, bg: colors.success, label: "Effettuato" },
  cancelled: { color: colors.onSurfaceTertiary, bg: colors.surfaceTertiary, label: "Annullato" },
};

export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [mode, setMode] = useState<ViewMode>("day");
  const [current, setCurrent] = useState<Date>(new Date());
  const [voiceOpen, setVoiceOpen] = useState(false);

  const range = useMemo(() => {
    if (mode === "day") return { start: toISODate(current), end: toISODate(current) };
    if (mode === "week") {
      const s = startOfWeek(current);
      return { start: toISODate(s), end: toISODate(addDays(s, 6)) };
    }
    return { start: toISODate(startOfMonth(current)), end: toISODate(endOfMonth(current)) };
  }, [mode, current]);

  const appointmentsQ = useQuery({
    queryKey: ["appointments", range.start, range.end],
    queryFn: () => api.get<Appointment[]>("/appointments", range),
  });
  const patientsQ = useQuery({
    queryKey: ["patients"],
    queryFn: () => api.get<Patient[]>("/patients"),
  });

  const patientMap = useMemo(() => {
    const m = new Map<string, Patient>();
    (patientsQ.data ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [patientsQ.data]);

  const shift = (delta: number) => {
    if (mode === "day") setCurrent(addDays(current, delta));
    else if (mode === "week") setCurrent(addDays(current, delta * 7));
    else setCurrent(new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  const title = useMemo(() => {
    if (mode === "day") return fmtDayLong(current);
    if (mode === "week") {
      const s = startOfWeek(current);
      const e = addDays(s, 6);
      return `${s.getDate()} ${MONTHS_IT[s.getMonth()]} – ${e.getDate()} ${MONTHS_IT[e.getMonth()]}`;
    }
    return `${MONTHS_IT[current.getMonth()]} ${current.getFullYear()}`;
  }, [mode, current]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Sticky header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            testID="cal-prev"
            onPress={() => shift(-1)}
            style={styles.iconBtn}
          >
            <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="cal-title"
            onPress={() => setCurrent(new Date())}
            style={{ flex: 1 }}
          >
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>Tocca per oggi</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="cal-next"
            onPress={() => shift(1)}
            style={styles.iconBtn}
          >
            <Ionicons name="chevron-forward" size={22} color={colors.onSurface} />
          </TouchableOpacity>
        </View>

        <View style={styles.segment}>
          {(["day", "week", "month"] as ViewMode[]).map((m) => (
            <TouchableOpacity
              testID={`view-${m}`}
              key={m}
              onPress={() => setMode(m)}
              style={[
                styles.segmentItem,
                mode === m && { backgroundColor: colors.surface },
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  mode === m && { color: colors.brandPrimary, fontWeight: "700" },
                ]}
              >
                {m === "day" ? "Giorno" : m === "week" ? "Settimana" : "Mese"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Body */}
      {appointmentsQ.isLoading || patientsQ.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : mode === "day" ? (
        <DayView
          date={current}
          appointments={(appointmentsQ.data ?? []).filter((a) => a.date === toISODate(current))}
          patientMap={patientMap}
          onSelect={(a) => router.push(`/appuntamento/${a.id}`)}
        />
      ) : mode === "week" ? (
        <WeekView
          current={current}
          appointments={appointmentsQ.data ?? []}
          patientMap={patientMap}
          onSelect={(a) => router.push(`/appuntamento/${a.id}`)}
          onSelectDay={(d) => {
            setCurrent(d);
            setMode("day");
          }}
        />
      ) : (
        <MonthView
          current={current}
          appointments={appointmentsQ.data ?? []}
          onSelectDay={(d) => {
            setCurrent(d);
            setMode("day");
          }}
        />
      )}

      {/* Voice FAB */}
      <TouchableOpacity
        testID="voice-fab"
        style={[styles.voiceFab, { bottom: 16 + spacing.md }]}
        onPress={() => setVoiceOpen(true)}
      >
        <Ionicons name="mic" size={22} color={colors.onSurface} />
      </TouchableOpacity>

      {/* FAB */}
      <TouchableOpacity
        testID="add-appointment-fab"
        style={[styles.fab, { bottom: 16 + spacing.md }]}
        onPress={() => router.push({ pathname: "/appuntamento/nuovo", params: { date: toISODate(current) } })}
      >
        <Ionicons name="add" size={30} color={colors.onBrandPrimary} />
      </TouchableOpacity>

      <VoiceAssistant visible={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </View>
  );
}

/* ---------------- Day view ---------------- */

function DayView({
  date,
  appointments,
  patientMap,
  onSelect,
}: {
  date: Date;
  appointments: Appointment[];
  patientMap: Map<string, Patient>;
  onSelect: (a: Appointment) => void;
}) {
  const sorted = [...appointments].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const totalMin = sorted
    .filter((a) => a.status !== "cancelled")
    .reduce((s, a) => s + a.duration_minutes, 0);
  const total = sorted
    .filter((a) => a.status !== "cancelled")
    .reduce((s, a) => s + a.amount, 0);
  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}
      testID="day-list"
    >
      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="calendar-outline" size={56} color={colors.muted} />
          <Text style={styles.emptyTitle}>Giornata libera</Text>
          <Text style={styles.emptySub}>Nessuna terapia programmata.</Text>
        </View>
      ) : (
        <>
          <View style={styles.kpiRow}>
            <KPI label="Sedute" value={String(sorted.filter((a) => a.status !== "cancelled").length)} />
            <KPI label="Ore" value={minutesToText(totalMin)} />
            <KPI label="Totale" value={euro(total)} />
          </View>
          {sorted.map((a) => {
            const p = patientMap.get(a.patient_id);
            const s = STATUS_META[a.status];
            return (
              <TouchableOpacity
                testID={`appt-${a.id}`}
                key={a.id}
                style={[
                  styles.apptCard,
                  a.status === "cancelled" && { opacity: 0.55 },
                  { borderLeftColor: s.bg, borderLeftWidth: 4 },
                ]}
                onPress={() => onSelect(a)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.apptTime}>
                    {a.start_time}–{a.end_time}
                  </Text>
                  <Text style={styles.apptName}>
                    {p ? `${p.first_name} ${p.last_name}` : "Paziente"}
                  </Text>
                  <Text style={styles.apptMeta}>
                    {minutesToText(a.duration_minutes)} · {euro(a.amount)}
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: s.bg }]}>
                  <Text style={[styles.statusText, { color: s.color }]}>{s.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

/* ---------------- Week view ---------------- */

function WeekView({
  current,
  appointments,
  patientMap,
  onSelect,
  onSelectDay,
}: {
  current: Date;
  appointments: Appointment[];
  patientMap: Map<string, Patient>;
  onSelect: (a: Appointment) => void;
  onSelectDay: (d: Date) => void;
}) {
  const start = startOfWeek(current);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const grouped = new Map<string, Appointment[]>();
  appointments.forEach((a) => {
    grouped.set(a.date, [...(grouped.get(a.date) ?? []), a]);
  });
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}>
      {days.map((d) => {
        const iso = toISODate(d);
        const list = (grouped.get(iso) ?? []).sort((a, b) =>
          a.start_time.localeCompare(b.start_time),
        );
        return (
          <View key={iso} style={styles.weekDay}>
            <TouchableOpacity onPress={() => onSelectDay(d)}>
              <Text style={styles.weekDayTitle}>
                {WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} {d.getDate()}
              </Text>
            </TouchableOpacity>
            {list.length === 0 ? (
              <Text style={styles.weekDayEmpty}>—</Text>
            ) : (
              list.map((a) => {
                const p = patientMap.get(a.patient_id);
                const s = STATUS_META[a.status];
                return (
                  <TouchableOpacity
                    testID={`week-appt-${a.id}`}
                    key={a.id}
                    onPress={() => onSelect(a)}
                    style={[
                      styles.weekAppt,
                      { borderLeftColor: s.bg, borderLeftWidth: 3 },
                    ]}
                  >
                    <Text style={styles.weekApptTime}>
                      {a.start_time}–{a.end_time}
                    </Text>
                    <Text style={styles.weekApptName} numberOfLines={1}>
                      {p ? `${p.first_name} ${p.last_name}` : "Paziente"}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

/* ---------------- Month view ---------------- */

function MonthView({
  current,
  appointments,
  onSelectDay,
}: {
  current: Date;
  appointments: Appointment[];
  onSelectDay: (d: Date) => void;
}) {
  const firstOfMonth = startOfMonth(current);
  const lastOfMonth = endOfMonth(current);
  const gridStart = startOfWeek(firstOfMonth);
  const cells: Date[] = [];
  let d = new Date(gridStart);
  while (d <= lastOfMonth || cells.length % 7 !== 0) {
    cells.push(new Date(d));
    d = addDays(d, 1);
    if (cells.length > 42) break;
  }
  const counts = new Map<string, number>();
  appointments.forEach((a) => {
    if (a.status !== "cancelled") counts.set(a.date, (counts.get(a.date) ?? 0) + 1);
  });
  const todayISO = toISODate(new Date());
  return (
    <View style={{ padding: spacing.lg }}>
      <View style={styles.monthHeader}>
        {WEEKDAYS_SHORT.map((w) => (
          <Text key={w} style={styles.monthHeaderCell}>
            {w}
          </Text>
        ))}
      </View>
      <View style={styles.monthGrid}>
        {cells.map((c) => {
          const iso = toISODate(c);
          const inMonth = c.getMonth() === current.getMonth();
          const count = counts.get(iso) ?? 0;
          const isToday = iso === todayISO;
          return (
            <TouchableOpacity
              testID={`month-cell-${iso}`}
              key={iso}
              style={[
                styles.monthCell,
                !inMonth && { opacity: 0.35 },
                isToday && { backgroundColor: colors.brandTertiary },
              ]}
              onPress={() => onSelectDay(c)}
            >
              <Text
                style={[
                  styles.monthCellDay,
                  isToday && { color: colors.brandPrimary, fontWeight: "700" },
                ]}
              >
                {c.getDate()}
              </Text>
              {count > 0 && (
                <View style={styles.monthDot}>
                  <Text style={styles.monthDotText}>{count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/* ---------------- Small components ---------------- */

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
  },
  title: {
    textAlign: "center",
    fontSize: 18,
    fontWeight: "700",
    color: colors.onSurface,
  },
  subtitle: {
    textAlign: "center",
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: "center",
  },
  segmentText: { fontSize: 13, color: colors.onSurfaceSecondary, fontWeight: "500" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  empty: { alignItems: "center", paddingTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.onSurface, marginTop: 12 },
  emptySub: { color: colors.muted, marginTop: 4 },

  kpiRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  kpi: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "flex-start",
  },
  kpiValue: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  kpiLabel: { fontSize: 11, color: colors.muted, marginTop: 2 },

  apptCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  apptTime: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  apptName: { fontSize: 16, color: colors.onSurface, fontWeight: "700", marginTop: 2 },
  apptMeta: { fontSize: 12, color: colors.onSurfaceSecondary, marginTop: 3 },

  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusText: { fontSize: 11, fontWeight: "700" },

  weekDay: {
    marginBottom: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  weekDayTitle: { fontSize: 14, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.sm },
  weekDayEmpty: { color: colors.muted, fontSize: 12 },
  weekAppt: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: 4,
  },
  weekApptTime: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  weekApptName: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },

  monthHeader: { flexDirection: "row", marginBottom: 6 },
  monthHeaderCell: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: colors.muted,
  },
  monthGrid: { flexDirection: "row", flexWrap: "wrap" },
  monthCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    padding: 4,
    alignItems: "center",
    borderRadius: radius.sm,
  },
  monthCellDay: { fontSize: 14, color: colors.onSurface },
  monthDot: {
    marginTop: 4,
    backgroundColor: colors.brandPrimary,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  monthDotText: { color: colors.onBrandPrimary, fontSize: 10, fontWeight: "700" },

  fab: {
    position: "absolute",
    right: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  voiceFab: {
    position: "absolute",
    right: spacing.lg + 72,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 4,
  },
});
