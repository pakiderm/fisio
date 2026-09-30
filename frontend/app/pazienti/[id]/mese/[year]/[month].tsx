import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, downloadUrl } from "@/src/api";
import { MONTHS_IT, euro, fmtDayLong, fmtDayShort, fromISODate, minutesToText, toISODate } from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { Appointment, Invoice, InvoicePreview, Patient } from "@/src/types";

export default function MonthDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, year, month } = useLocalSearchParams<{ id: string; year: string; month: string }>();
  const yearN = Number(year);
  const monthN = Number(month);
  const qc = useQueryClient();
  const [issueDate, setIssueDate] = useState<string>(toISODate(new Date()));
  const [showDatePicker, setShowDatePicker] = useState(false);

  const patientQ = useQuery({
    queryKey: ["patient", id],
    queryFn: () => api.get<Patient>(`/patients/${id}`),
  });
  const monthQ = useQuery({
    queryKey: ["month", id, yearN, monthN],
    queryFn: () =>
      api.get<{ appointments: Appointment[]; invoice: Invoice | null }>(
        `/patients/${id}/history/${yearN}/${monthN}`,
      ),
  });
  const previewQ = useQuery({
    queryKey: ["preview", id, yearN, monthN],
    queryFn: () =>
      api.post<InvoicePreview>("/invoices/preview", {
        patient_id: id,
        year: yearN,
        month: monthN,
      }),
    enabled: !!monthQ.data && !monthQ.data.invoice,
  });

  const confirm = useMutation({
    mutationFn: () =>
      api.post<Invoice>("/invoices/confirm", {
        patient_id: id,
        year: yearN,
        month: monthN,
        issue_date: issueDate,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["month", id, yearN, monthN] });
      qc.invalidateQueries({ queryKey: ["history", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["appointments"] });
    },
  });

  const openInvoice = async (inv: Invoice, fmt: "xlsx" | "pdf") => {
    const url = downloadUrl(inv.id, fmt);
    if (Platform.OS === "web") {
      window.open(url, "_blank");
      return;
    }
    const name = `fattura_${inv.number}_${inv.year}_${String(inv.month).padStart(2, "0")}.${fmt}`;
    const target = `${FileSystem.cacheDirectory}${name}`;
    const res = await FileSystem.downloadAsync(url, target);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(res.uri, {
        mimeType:
          fmt === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/pdf",
        dialogTitle: `Fattura ${inv.number_full}`,
        UTI: fmt === "xlsx" ? "org.openxmlformats.spreadsheetml.sheet" : "com.adobe.pdf",
      });
    }
  };

  if (patientQ.isLoading || monthQ.isLoading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }
  const p = patientQ.data;
  const invoice = monthQ.data?.invoice;
  const preview = previewQ.data;
  const apps = monthQ.data?.appointments ?? [];
  const fatturabili = apps.filter((a) => a.status !== "cancelled");

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {MONTHS_IT[monthN - 1]} {yearN}
          </Text>
          <Text style={styles.subtitle}>
            {p?.last_name} {p?.first_name}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}>
        {invoice && (
          <View style={styles.invoicedBanner}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={styles.invoicedTitle}>Fatturato – {invoice.number_full}</Text>
              <Text style={styles.invoicedSub}>
                Emessa il {fmtDayShort(invoice.issue_date)} · {euro(invoice.total)}
              </Text>
            </View>
          </View>
        )}

        {/* Anteprima block */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Prestazioni del mese</Text>
          {apps.length === 0 ? (
            <Text style={styles.emptyText}>Nessuna prestazione in questo mese.</Text>
          ) : (
            apps.map((a) => (
              <View
                key={a.id}
                style={[
                  styles.line,
                  a.status === "cancelled" && { opacity: 0.5 },
                ]}
              >
                <Text style={styles.lineDate}>{fmtDayShort(a.date)}</Text>
                <Text style={styles.lineTime}>
                  {a.start_time}–{a.end_time}
                </Text>
                <Text style={styles.lineDur}>{minutesToText(a.duration_minutes)}</Text>
                <Text style={styles.lineAmount}>
                  {a.status === "cancelled" ? "annullata" : euro(a.amount)}
                </Text>
              </View>
            ))
          )}
        </View>

        {!invoice && preview && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Anteprima fattura</Text>
            <Row label="Numero" value={preview.next_invoice_number_full} />
            <TouchableOpacity
              testID="pick-issue-date"
              onPress={() => setShowDatePicker(true)}
              style={styles.issueDateRow}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Data di emissione</Text>
                <Text style={styles.issueDateValue}>
                  {fmtDayLong(fromISODate(issueDate))}
                </Text>
              </View>
              <Ionicons name="calendar" size={20} color={colors.brandPrimary} />
            </TouchableOpacity>
            <Row
              label="Paziente"
              value={`${preview.patient.last_name} ${preview.patient.first_name}`}
            />
            {!!preview.patient.hcp_code && (
              <Row label="Pratica HCP" value={preview.patient.hcp_code} />
            )}
            <Row label="Ore totali" value={`${preview.total_hours} h`} />
            <Row label="Tariffa" value={`${euro(preview.hourly_rate)}/h`} />
            <Row label="Imponibile" value={euro(preview.imponibile)} />
            <Row label="Bollo" value={euro(preview.stamp_duty)} />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>TOTALE</Text>
              <Text style={styles.totalValue}>{euro(preview.total)}</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Sticky footer */}
      <View style={[styles.footer, { paddingBottom: (insets.bottom || 0) + spacing.md }]}>
        {invoice ? (
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <TouchableOpacity
              testID="open-xlsx"
              onPress={() => openInvoice(invoice, "xlsx")}
              style={[styles.smallBtn, { backgroundColor: colors.surfaceSecondary, flex: 1 }]}
            >
              <Ionicons name="document" size={18} color={colors.brandPrimary} />
              <Text style={styles.smallBtnText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="open-pdf"
              onPress={() => openInvoice(invoice, "pdf")}
              style={[styles.smallBtn, { backgroundColor: colors.surfaceSecondary, flex: 1 }]}
            >
              <Ionicons name="document-text" size={18} color={colors.brandPrimary} />
              <Text style={styles.smallBtnText}>PDF</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            testID="confirm-invoice"
            onPress={() => {
              if (fatturabili.length === 0) return;
              Alert.alert(
                "Conferma emissione",
                `Emettere la fattura ${preview?.next_invoice_number_full} del ${fmtDayShort(issueDate)}?\nTotale ${euro(
                  preview?.total ?? 0,
                )}`,
                [
                  { text: "Annulla", style: "cancel" },
                  { text: "Conferma", onPress: () => confirm.mutate() },
                ],
              );
            }}
            disabled={fatturabili.length === 0 || confirm.isPending}
            style={[
              styles.primary,
              (fatturabili.length === 0 || confirm.isPending) && { opacity: 0.5 },
            ]}
          >
            {confirm.isPending ? (
              <ActivityIndicator color={colors.onBrandPrimary} />
            ) : (
              <>
                <Ionicons name="checkmark" size={20} color={colors.onBrandPrimary} />
                <Text style={styles.primaryText}>Conferma e crea fattura</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {showDatePicker && (
        <DatePickerModal
          initial={issueDate}
          onCancel={() => setShowDatePicker(false)}
          onSelect={(v) => {
            setIssueDate(v);
            setShowDatePicker(false);
          }}
        />
      )}
    </View>
  );
}

/* ---- Simple date-picker modal ---- */
function DatePickerModal({
  initial,
  onCancel,
  onSelect,
}: {
  initial: string;
  onCancel: () => void;
  onSelect: (iso: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const init = fromISODate(initial);
  const [year, setYear] = useState(init.getFullYear());
  const [month, setMonth] = useState(init.getMonth());
  const [day, setDay] = useState(init.getDate());
  const daysIn = new Date(year, month + 1, 0).getDate();
  const years = Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 2 + i);
  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.datePickerCard, { paddingBottom: insets.bottom + 16 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <TouchableOpacity onPress={onCancel} testID="dp-cancel">
              <Text style={{ color: colors.muted, fontSize: 16 }}>Annulla</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.onSurface }}>
              Data di emissione
            </Text>
            <TouchableOpacity
              testID="dp-ok"
              onPress={() => {
                const d = Math.min(day, daysIn);
                onSelect(
                  `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
                );
              }}
            >
              <Text style={{ color: colors.brandPrimary, fontWeight: "700", fontSize: 16 }}>OK</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <PickerColumn
              testIDPrefix="dp-day"
              values={Array.from({ length: daysIn }, (_, i) => i + 1)}
              selected={day}
              onSelect={setDay}
              format={(v) => String(v)}
            />
            <PickerColumn
              testIDPrefix="dp-month"
              values={MONTHS_IT.map((_, i) => i)}
              selected={month}
              onSelect={setMonth}
              format={(v) => MONTHS_IT[v]}
            />
            <PickerColumn
              testIDPrefix="dp-year"
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

function PickerColumn<T>({
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  emptyText: { color: colors.muted, textAlign: "center", paddingVertical: 12 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  lineDate: { flex: 1.4, fontSize: 13, color: colors.onSurface, fontWeight: "600" },
  lineTime: { flex: 1.3, fontSize: 12, color: colors.onSurfaceSecondary },
  lineDur: { flex: 0.9, fontSize: 12, color: colors.muted, textAlign: "center" },
  lineAmount: {
    flex: 1.2,
    fontSize: 13,
    color: colors.onSurface,
    fontWeight: "700",
    textAlign: "right",
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  rowLabel: { color: colors.muted, fontSize: 13 },
  rowValue: { color: colors.onSurface, fontSize: 14, fontWeight: "600" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
  },
  totalLabel: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  totalValue: { fontSize: 20, fontWeight: "800", color: colors.brandPrimary },

  invoicedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  invoicedTitle: { color: colors.onSurface, fontWeight: "800", fontSize: 15 },
  invoicedSub: { color: colors.muted, fontSize: 12, marginTop: 2 },

  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  primary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  primaryText: { color: colors.onBrandPrimary, fontWeight: "700", fontSize: 16 },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  smallBtnText: { color: colors.brandPrimary, fontWeight: "700" },

  issueDateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    marginVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.brandTertiary,
  },
  issueDateValue: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: 2,
  },
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
});
