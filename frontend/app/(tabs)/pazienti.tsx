import Ionicons from "@react-native-vector-icons/ionicons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { initials } from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { Patient } from "@/src/types";

export default function PatientsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [q, setQ] = useState("");

  const patientsQ = useQuery({
    queryKey: ["patients"],
    queryFn: () => api.get<Patient[]>("/patients"),
  });

  const filtered = useMemo(() => {
    const list = patientsQ.data ?? [];
    if (!q.trim()) return list;
    const s = q.trim().toLowerCase();
    return list.filter(
      (p) =>
        p.first_name.toLowerCase().includes(s) ||
        p.last_name.toLowerCase().includes(s) ||
        p.codice_fiscale.toLowerCase().includes(s),
    );
  }, [patientsQ.data, q]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Pazienti</Text>
          <TouchableOpacity
            testID="add-patient-btn"
            onPress={() => router.push("/pazienti/nuovo")}
            style={styles.addBtn}
          >
            <Ionicons name="add" size={24} color={colors.onBrandPrimary} />
          </TouchableOpacity>
        </View>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="patient-search"
            placeholder="Cerca per nome, cognome o CF"
            placeholderTextColor={colors.muted}
            value={q}
            onChangeText={setQ}
            style={styles.searchInput}
          />
        </View>
      </View>

      {patientsQ.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={56} color={colors.muted} />
          <Text style={styles.emptyTitle}>
            {q ? "Nessun risultato" : "Nessun paziente in rubrica"}
          </Text>
          {!q && (
            <TouchableOpacity
              testID="add-first-patient"
              style={styles.emptyBtn}
              onPress={() => router.push("/pazienti/nuovo")}
            >
              <Text style={styles.emptyBtnText}>Aggiungi paziente</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`patient-${item.id}`}
              style={styles.row}
              onPress={() => router.push(`/pazienti/${item.id}`)}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(item.first_name, item.last_name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>
                  {item.last_name} {item.first_name}
                </Text>
                {!!item.codice_fiscale && (
                  <Text style={styles.rowMeta}>{item.codice_fiscale}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </TouchableOpacity>
          )}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: spacing.sm,
  },
  title: { fontSize: 28, fontWeight: "800", color: colors.onSurface },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 40,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: colors.onSurface,
    fontSize: 15,
    paddingVertical: 0,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg },
  emptyTitle: { fontSize: 16, color: colors.muted, marginTop: 12 },
  emptyBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.brandPrimary,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: radius.md,
  },
  emptyBtnText: { color: colors.onBrandPrimary, fontWeight: "700" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.onBrandTertiary, fontWeight: "700", fontSize: 15 },
  rowName: { fontSize: 16, fontWeight: "700", color: colors.onSurface },
  rowMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
});
