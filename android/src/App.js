import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Picker } from "@react-native-picker/picker";
import * as ImagePicker from "expo-image-picker";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import Svg, { Circle, Path } from "react-native-svg";
import Decimal from "decimal.js";
import {
  calculateAnalytics,
  convertToBRL,
  localDate,
  marketComparison,
} from "./finance";
import {
  clearPending,
  getDatabase,
  migrateCreatedProduct,
  queueDelete,
  readCurrencies,
  readPending,
  readProducts,
  readRates,
  removeServerProduct,
  resolveServerVersion,
  saveConflict,
  saveCurrencies,
  saveLocalProduct,
  saveRates,
  saveServerProduct,
} from "./storage";

const API = process.env.EXPO_PUBLIC_API_URL ?? "https://localhost:8080";
const COLORS = ["#198754", "#df9a29"];
const EMPTY_PRODUCT = () => ({
  name: "",
  imageData: "",
  observations: "",
  salePrice: null,
  marketValue: null,
  currency: "BRL",
  entryDate: localDate(),
  status: "stock",
  saleDate: null,
  costs: [],
});

function conflictSummary(product) {
  if (!product) return "Produto removido do servidor.";
  const costTotal = (product.costs ?? []).reduce((total, item) => {
    try { return total.plus(item.price ?? 0); } catch { return total; }
  }, new Decimal(0));
  return `${product.name} · ${product.status === "stock" ? "Em estoque" : "Vendido"} · ` +
    `venda: ${product.salePrice ?? "não informada"} · custos: ${costTotal.toString()}`;
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim().replace(",", ".");
}

async function request(path, { token, ...options } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Sem conexão com o servidor. As alterações locais foram preservadas.");
  }
  const result = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result?.error ?? result?.message ?? "A operação falhou.");
    error.status = response.status;
    error.current = result?.current;
    throw error;
  }
  return result;
}

function todayString() {
  return localDate();
}

function money(value, currency) {
  if (value === null || value === undefined) return "Não disponível";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency} ${new Decimal(value).toFixed(2)}`;
  }
}

function cleanProduct(product) {
  return {
    name: product.name,
    imageData: product.imageData ?? "",
    observations: product.observations ?? "",
    salePrice: normalizeAmount(product.salePrice),
    marketValue: normalizeAmount(product.marketValue),
    currency: product.currency,
    entryDate: product.entryDate,
    status: product.status,
    saleDate: product.status === "sold" ? product.saleDate : null,
    costs: (product.costs ?? []).map(({ title, price }) => ({ title: title.trim(), price: normalizeAmount(price) })),
  };
}

function Button({ title, onPress, kind = "primary", disabled = false, compact = false }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, styles[`button_${kind}`], compact && styles.buttonCompact, disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonText, kind === "secondary" && styles.secondaryText, kind === "text" && styles.textButtonText]}>
        {title}
      </Text>
    </Pressable>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType, multiline = false, secureTextEntry = false }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value ?? ""}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        style={[styles.input, multiline && styles.multiline]}
      />
    </View>
  );
}

function AuthScreen({ onSession }) {
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username.trim() || !password) {
      setMessage("Nome de usuário e senha são obrigatórios.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const session = await request(`/api/auth/${registering ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, email }),
      });
      await SecureStore.setItemAsync("session", JSON.stringify(session));
      onSession(session);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
      syncLock.current = false;
    }
  }

  return (
    <SafeAreaView style={styles.authScreen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.authCard}>
        <Text style={styles.eyebrow}>GESTÃO DE CUSTOS</Text>
        <Text style={styles.title}>{registering ? "Criar conta" : "Entrar"}</Text>
        <Text style={styles.muted}>Cadastre produtos, custos e vendas.</Text>
        {message ? <Text accessibilityRole="alert" style={styles.errorText}>{message}</Text> : null}
        <Field label="Nome de usuário" value={username} onChangeText={setUsername} />
        <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry />
        {registering && <Field label="E-mail (opcional)" value={email} onChangeText={setEmail} keyboardType="email-address" />}
        <Button title={busy ? "Aguarde..." : registering ? "Criar conta" : "Entrar"} onPress={submit} disabled={busy} />
        <Button title={registering ? "Já tenho uma conta" : "Criar uma conta"} onPress={() => { setRegistering(!registering); setMessage(""); }} kind="text" />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ProductEditor({ product, currencies, onSave, onClose, saving }) {
  const [form, setForm] = useState(() => ({ ...product, costs: (product.costs ?? []).map((cost) => ({ ...cost })) }));
  const [costDraft, setCostDraft] = useState({ title: "", price: "" });
  const [error, setError] = useState("");
  const costTotal = useMemo(() => {
    try {
      return form.costs.reduce((sum, item) => sum.plus(normalizeAmount(item.price) || 0), new Decimal(0)).toString();
    } catch {
      return null;
    }
  }, [form.costs]);

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeCost(index, key, value) {
    setForm((current) => ({
      ...current,
      costs: current.costs.map((cost, costIndex) => costIndex === index ? { ...cost, [key]: value } : cost),
    }));
  }

  async function chooseImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("É necessário permitir o acesso às imagens para selecionar uma imagem de produto.");
      return;
    }
    const selection = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.9 });
    if (selection.canceled) return;
    const asset = selection.assets[0];
    if (asset.fileSize > 5 * 1024 * 1024) {
      setError("A imagem deve ter no máximo 5 MB.");
      return;
    }
    const mime = asset.mimeType;
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      setError("Formato aceito: JPEG, PNG ou WebP.");
      return;
    }
    set("imageData", `data:${mime};base64,${asset.base64}`);
    setError("");
  }

  async function submit() {
    if (!form.name.trim()) return setError("Informe o nome do produto.");
    if (!validISODate(form.entryDate)) return setError("Informe uma data de entrada válida.");
    if (form.status === "sold" && !validISODate(form.saleDate)) return setError("Informe uma data de venda válida.");
    if (form.costs.some((cost) => {
      try { return !cost.title.trim() || normalizeAmount(cost.price) === null || new Decimal(normalizeAmount(cost.price)).isNegative(); }
      catch { return true; }
    })) {
      return setError("Cada custo precisa de título e preço não negativo.");
    }
    if ([form.salePrice, form.marketValue].some((value) => {
      try { return value !== null && value !== "" && new Decimal(normalizeAmount(value)).isNegative(); }
      catch { return value !== null && value !== ""; }
    })) {
      return setError("Os valores monetários não podem ser negativos.");
    }
    try {
      await onSave({ ...form, ...cleanProduct(form), name: form.name.trim() });
    } catch (reason) {
      setError(reason.message);
    }
  }

  const currencyCodes = Object.keys(currencies).length ? Object.keys(currencies).sort() : ["BRL"];
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalHeading}>
            <View><Text style={styles.eyebrow}>PRODUTO</Text><Text style={styles.heading}>{product.id ? "Editar produto" : "Novo produto"}</Text></View>
            <Button title="Fechar" kind="text" onPress={onClose} compact />
          </View>
          {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
          <Field label="Nome" value={form.name} onChangeText={(value) => set("name", value)} />
          <Text style={styles.fieldLabel}>Moeda</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={form.currency} onValueChange={(value) => set("currency", value)}>
              {currencyCodes.map((code) => <Picker.Item key={code} label={`${code}${currencies[code] ? ` — ${currencies[code]}` : ""}`} value={code} />)}
              {!currencyCodes.includes(form.currency) && <Picker.Item label={form.currency} value={form.currency} />}
            </Picker>
          </View>
          <Field label="Data de entrada (AAAA-MM-DD)" value={form.entryDate} onChangeText={(value) => set("entryDate", value)} placeholder="AAAA-MM-DD" />
          <Field label="Preço de venda (opcional)" value={form.salePrice == null ? "" : String(form.salePrice)} onChangeText={(value) => set("salePrice", value)} keyboardType="decimal-pad" />
          <Field label="Valor de mercado (opcional)" value={form.marketValue == null ? "" : String(form.marketValue)} onChangeText={(value) => set("marketValue", value)} keyboardType="decimal-pad" />
          <Text style={styles.fieldLabel}>Situação</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={form.status} onValueChange={(status) => {
              set("status", status);
              set("saleDate", status === "sold" ? form.saleDate || todayString() : null);
            }}>
              <Picker.Item label="Em estoque" value="stock" />
              <Picker.Item label="Vendido" value="sold" />
            </Picker>
          </View>
          {form.status === "sold" && <Field label="Data da venda (AAAA-MM-DD)" value={form.saleDate ?? todayString()} onChangeText={(value) => set("saleDate", value)} placeholder="AAAA-MM-DD" />}
          <Field label="Observações (opcional)" value={form.observations} onChangeText={(value) => set("observations", value)} multiline />
          <Text style={styles.fieldLabel}>Imagem (JPEG, PNG ou WebP; até 5 MB)</Text>
          <View style={styles.imageRow}>
            {form.imageData ? <Image source={{ uri: form.imageData }} style={styles.preview} accessibilityLabel="Prévia da imagem do produto" /> : null}
            <Button title={form.imageData ? "Substituir imagem" : "Selecionar imagem"} onPress={chooseImage} kind="secondary" compact />
            {form.imageData ? <Button title="Remover" onPress={() => set("imageData", "")} kind="text" compact /> : null}
          </View>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>Custos</Text>
            <Text style={styles.muted}>Total: {money(costTotal, form.currency)}</Text>
          </View>
          {form.costs.map((cost, index) => (
            <View style={styles.costRow} key={cost.id ?? index}>
              <TextInput accessibilityLabel={`Título do custo ${index + 1}`} style={[styles.input, styles.costTitle]} placeholder="Título" value={cost.title} onChangeText={(value) => changeCost(index, "title", value)} />
              <TextInput accessibilityLabel={`Preço do custo ${index + 1}`} style={[styles.input, styles.costPrice]} placeholder="Preço" keyboardType="decimal-pad" value={String(cost.price)} onChangeText={(value) => changeCost(index, "price", value)} />
              <Button title="×" onPress={() => setForm((current) => ({ ...current, costs: current.costs.filter((_, costIndex) => costIndex !== index) }))} kind="danger" compact />
            </View>
          ))}
          <View style={styles.costRow}>
            <TextInput accessibilityLabel="Título do novo custo" style={[styles.input, styles.costTitle]} placeholder="Novo custo" value={costDraft.title} onChangeText={(value) => setCostDraft({ ...costDraft, title: value })} />
            <TextInput accessibilityLabel="Preço do novo custo" style={[styles.input, styles.costPrice]} placeholder="Preço" keyboardType="decimal-pad" value={costDraft.price} onChangeText={(value) => setCostDraft({ ...costDraft, price: value })} />
            <Button title="+" onPress={() => {
              try {
                if (!costDraft.title.trim() || normalizeAmount(costDraft.price) === null || new Decimal(normalizeAmount(costDraft.price)).isNegative()) {
                  return setError("Informe título e preço não negativo para o custo.");
                }
              } catch {
                return setError("Informe um preço válido para o custo.");
              }
              setForm((current) => ({ ...current, costs: [...current.costs, { ...costDraft }] }));
              setCostDraft({ title: "", price: "" });
              setError("");
            }} compact />
          </View>
          <View style={styles.modalButtons}>
            <Button title="Cancelar" kind="secondary" onPress={onClose} />
            <Button title={saving ? "Salvando..." : "Salvar produto"} onPress={submit} disabled={saving} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function DetailModal({ product, currencyView, hiddenCosts, rates, onClose, onEdit }) {
  if (!product) return null;
  const currency = currencyView === "BRL" ? "BRL" : product.currency;
  const amount = (value) => hiddenCosts ? "••••••" : money(currencyView === "BRL" ? convertToBRL(value, product.currency, rates) : value, currency);
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <ScrollView contentContainerStyle={styles.modalContent}>
          <View style={styles.modalHeading}>
            <View><Text style={styles.eyebrow}>DETALHES</Text><Text style={styles.heading}>{product.name}</Text></View>
            <Button title="Fechar" kind="text" onPress={onClose} compact />
          </View>
          {product.imageData ? <Image source={{ uri: product.imageData }} style={styles.detailImage} accessibilityLabel={`Imagem de ${product.name}`} /> : null}
          <DetailRow label="Situação" value={product.status === "stock" ? "Em estoque" : "Vendido"} />
          <DetailRow label="Observações" value={product.observations || "Não informado"} />
          <DetailRow label="Moeda" value={product.currency} />
          <DetailRow label="Data de entrada" value={product.entryDate} />
          {product.status === "sold" && <DetailRow label="Data da venda" value={product.saleDate ?? "Não disponível"} />}
          <DetailRow label="Custo total" value={amount(product.costTotal)} />
          <DetailRow label="Preço de venda" value={money(product.salePrice, currency)} />
          <DetailRow label="Valor de mercado" value={money(currencyView === "BRL" ? convertToBRL(product.marketValue, product.currency, rates) : product.marketValue, currency)} />
          <Text style={styles.sectionTitle}>Custos individuais</Text>
          {product.costs?.length ? product.costs.map((cost, index) => (
            <DetailRow key={cost.id ?? index} label={cost.title} value={amount(cost.price)} />
          )) : <Text style={styles.muted}>Nenhum custo cadastrado.</Text>}
          <Button title="Editar produto" onPress={onEdit} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function DetailRow({ label, value }) {
  return <View style={styles.detailRow}><Text style={styles.muted}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>;
}

function ProductCard({ product, hiddenCosts, currencyView, rates, onEdit, onDetail, onDelete, onStatus }) {
  const currency = currencyView === "BRL" ? "BRL" : product.currency;
  const cost = currencyView === "BRL" ? convertToBRL(product.costTotal, product.currency, rates) : product.costTotal;
  const market = marketComparison(product.salePrice, product.marketValue);
  return (
    <View style={styles.card}>
      <View style={styles.cardTitleRow}>
        {product.imageData ? <Image source={{ uri: product.imageData }} style={styles.productImage} accessibilityLabel={`Imagem de ${product.name}`} /> : null}
        <View style={styles.cardTitle}>
          <Text style={styles.cardHeading}>{product.name}</Text>
          <Text style={[styles.status, product.status === "sold" ? styles.sold : styles.stock]}>
            {product.status === "stock" ? "Em estoque" : "Vendido"}
          </Text>
        </View>
        {product.isPending ? <Text style={styles.pendingTag}>Pendente</Text> : null}
      </View>
      {product.observations ? <Text style={styles.observations}>{product.observations}</Text> : null}
      <View style={styles.valueRow}>
        <View style={styles.valueCell}><Text style={styles.muted}>Custo total</Text><Text style={styles.valueText}>{hiddenCosts ? "••••••" : money(cost, currency)}</Text></View>
        <View style={styles.valueCell}><Text style={styles.muted}>Preço de venda</Text><Text style={[styles.valueText, styles.saleValue]}>{money(product.salePrice, currency)}</Text></View>
      </View>
      {product.marketValue !== null && <Text style={styles.marketText}>
        Valor de mercado: {money(currencyView === "BRL" ? convertToBRL(product.marketValue, product.currency, rates) : product.marketValue, currency)}
      </Text>}
      {market && product.salePrice !== null && product.marketValue !== null && <Text style={styles.marketText}>
        Preço {market.position} da referência em {money(new Decimal(market.difference).abs().toString(), product.currency)} ({new Decimal(market.percentage).toFixed(2)}%)
      </Text>}
      <Text style={styles.dateText}>Entrada: {product.entryDate}{product.status === "sold" ? `  ·  Venda: ${product.saleDate}` : ""}</Text>
      <View style={styles.inlineButtons}>
        <Button title="Detalhes" kind="secondary" compact onPress={() => onDetail(product)} />
        <Button title="Editar" kind="secondary" compact onPress={() => onEdit(product)} />
        <Button title="Excluir" kind="danger" compact onPress={() => onDelete(product)} />
        <Button title={product.status === "stock" ? "Vender" : "Voltar ao estoque"} kind="text" compact onPress={() => onStatus(product)} />
      </View>
    </View>
  );
}

function PieChart({ analytics, hiddenCosts }) {
  const positiveProfit = analytics.profit !== null && new Decimal(analytics.profit).isPositive();
  const costValue = analytics.profitCostTotal ? Number(analytics.profitCostTotal) : 0;
  const profitValue = positiveProfit ? Number(analytics.profit) : 0;
  const total = costValue + profitValue;
  if (!total) return <Text style={styles.muted}>Dados insuficientes para o gráfico.</Text>;
  const startAngle = -90;
  let currentAngle = startAngle;
  const parts = [{ label: "Custos", value: costValue, color: COLORS[0] }];
  if (positiveProfit) parts.push({ label: "Lucro", value: profitValue, color: COLORS[1] });
  const visibleParts = parts.filter((part) => part.value > 0);
  return (
    <View style={styles.chartWrapper}>
      <Svg width={190} height={190} viewBox="0 0 200 200" accessibilityLabel="Gráfico de custos e receita">
        <Circle cx="100" cy="100" r="77" fill="none" stroke="#edf0ed" strokeWidth="32" />
        {visibleParts.map((part) => {
          if (visibleParts.length === 1) {
            return <Circle key={part.label} cx="100" cy="100" r="77" fill="none" stroke={part.color} strokeWidth="32" accessibilityLabel={`${part.label}: ${hiddenCosts && part.label === "Custos" ? "ocultos" : money(part.value, "BRL")}`} />;
          }
          const angle = part.value / total * 360;
          const large = angle > 180 ? 1 : 0;
          const endAngle = currentAngle + angle;
          const startX = 100 + 77 * Math.cos(currentAngle * Math.PI / 180);
          const startY = 100 + 77 * Math.sin(currentAngle * Math.PI / 180);
          const endX = 100 + 77 * Math.cos(endAngle * Math.PI / 180);
          const endY = 100 + 77 * Math.sin(endAngle * Math.PI / 180);
          const path = `M ${startX} ${startY} A 77 77 0 ${large} 1 ${endX} ${endY}`;
          currentAngle = endAngle;
          return <Path key={part.label} d={path} fill="none" stroke={part.color} strokeWidth="32" accessibilityLabel={`${part.label}: ${hiddenCosts && part.label === "Custos" ? "ocultos" : money(part.value, "BRL")}`} />;
        })}
      </Svg>
    </View>
  );
}

function validISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function AnalyticsScreen({ products, rates, hiddenCosts, onToggleCosts }) {
  const [view, setView] = useState("stock");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtersValid = view !== "sold" || ((!month || (Number(month) >= 1 && Number(month) <= 12)) &&
    (!year || (/^\d{1,4}$/.test(year) && Number(year) >= 1)) &&
    (!from || validISODate(from)) && (!to || validISODate(to)) &&
    (!from || !to || from <= to));
  const analytics = useMemo(() => filtersValid ? calculateAnalytics(view, products, rates, { month, year, from, to }) : null,
    [filtersValid, view, products, rates, month, year, from, to]);
  const tabs = [["stock", "Estoque atual"], ["sold", "Vendidos"], ["all", "Todo o período"]];
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.analyticsControls}>
        <Button title={hiddenCosts ? "Revelar custos" : "Ocultar custos"} kind="secondary" compact onPress={onToggleCosts} />
        <Text style={styles.muted}>Custos: {hiddenCosts ? "ocultos" : "visíveis"}</Text>
      </View>
      <View style={styles.tabRow} accessibilityRole="tablist">
        {tabs.map(([key, title]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: view === key }}
          style={[styles.tab, view === key && styles.tabSelected]} onPress={() => setView(key)}>
          <Text style={[styles.tabText, view === key && styles.tabTextSelected]}>{title}</Text>
        </Pressable>)}
      </View>
      {view === "sold" && <View style={styles.filterCard}>
        <Text style={styles.fieldLabel}>Filtrar data da venda</Text>
        <View style={styles.filterInputs}>
          <TextInput accessibilityLabel="Mês" style={[styles.input, styles.filterInput]} placeholder="Mês (1–12)" keyboardType="number-pad" value={month} onChangeText={(value) => setMonth(value.replace(/[^0-9]/g, ""))} />
          <TextInput accessibilityLabel="Ano" style={[styles.input, styles.filterInput]} placeholder="Ano" keyboardType="number-pad" value={year} onChangeText={setYear} />
        </View>
        <View style={styles.filterInputs}>
          <TextInput accessibilityLabel="Data inicial" style={[styles.input, styles.filterInput]} placeholder="De AAAA-MM-DD" value={from} onChangeText={setFrom} />
          <TextInput accessibilityLabel="Data final" style={[styles.input, styles.filterInput]} placeholder="Até AAAA-MM-DD" value={to} onChangeText={setTo} />
        </View>
      </View>}
      {!filtersValid ? <Text accessibilityRole="alert" style={styles.errorText}>Revise mês, ano e intervalo de datas. Use datas válidas e um período inicial anterior ao final.</Text> : null}
      {analytics && <View style={styles.metricCard}>
        <Metric label={view === "stock" ? "Custo total do estoque" : "Despesas / custos"} value={analytics.costTotal} count={analytics.costProductCount} hiddenValue={hiddenCosts} />
        <Metric label={view === "stock" ? "Receita estimada" : "Receita"} value={analytics.revenue} count={analytics.profitProductCount} />
        <Metric label={analytics.profitStatus === "loss" ? "Prejuízo" : view === "stock" ? "Lucro estimado" : "Lucro"} value={analytics.profit} count={analytics.profitProductCount} />
        <Metric label="Diferença para o mercado" value={analytics.marketDifference} count={analytics.marketProductCount}
          suffix={analytics.marketPercent === null ? "" : ` (${new Decimal(analytics.marketPercent).toFixed(2)}%)`} />
        {analytics.profitStatus === "loss" ? <Text style={styles.lossText}>O conjunto analisado apresenta prejuízo.</Text> : null}
        {analytics.currencyUnavailable.length > 0 ? <Text style={styles.muted}>Taxas indisponíveis: {analytics.currencyUnavailable.join(", ")}.</Text> : null}
      </View>}
      {analytics && <View style={styles.chartCard}>
        <Text style={styles.sectionTitle}>Custos e resultado</Text>
        <PieChart analytics={analytics} hiddenCosts={hiddenCosts} />
        <Text style={styles.chartText}>Receita total considerada: {money(analytics.revenue, "BRL")}</Text>
        <View style={styles.chartLegend}>
          {analytics.profitCostTotal !== null && <Text style={styles.legendLine}>● Custos: {hiddenCosts ? "••••••" : money(analytics.profitCostTotal, "BRL")}</Text>}
          {analytics.profit !== null && new Decimal(analytics.profit).isPositive() && <Text style={styles.legendLine}>● Lucro: {money(analytics.profit, "BRL")}</Text>}
          {analytics.profitStatus === "loss" && <Text style={styles.lossText}>Prejuízo: {money(new Decimal(analytics.profit).abs().toString(), "BRL")}</Text>}
        </View>
      </View>}
      <Text style={styles.muted}>Valores das análises em BRL. São usadas as taxas mais recentes disponíveis, inclusive para registros históricos.</Text>
    </ScrollView>
  );
}

function Metric({ label, value, count, suffix = "", hiddenValue = false }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.metricValue}>{hiddenValue ? "••••••" : value === null ? "Não disponível" : `${money(value, "BRL")}${suffix}`}</Text>
      <Text style={styles.metricCount}>{count} {count === 1 ? "produto considerado" : "produtos considerados"}</Text>
    </View>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [page, setPage] = useState("products");
  const [products, setProducts] = useState([]);
  const [currencies, setCurrencies] = useState({});
  const [rates, setRates] = useState({});
  const [filter, setFilter] = useState("all");
  const [currencyView, setCurrencyView] = useState("original");
  const [hiddenCosts, setHiddenCosts] = useState(false);
  const [editing, setEditing] = useState(null);
  const [details, setDetails] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteName, setDeleteName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [networkState, setNetworkState] = useState(null);
  const [syncMessage, setSyncMessage] = useState("Carregando dados locais...");
  const [error, setError] = useState("");
  const syncRef = useRef(null);
  const syncLock = useRef(false);
  const localMutation = useRef(false);
  const accountID = session?.user?.id == null ? null : String(session.user.id);
  const offline = !networkState?.isConnected || networkState?.isInternetReachable === false;

  const reloadLocal = useCallback(async () => {
    if (!accountID) return;
    const [items, savedCurrencies, savedRates] = await Promise.all([
      readProducts(accountID), readCurrencies(accountID), readRates(accountID),
    ]);
    setProducts(items);
    setCurrencies(savedCurrencies);
    setRates(savedRates);
  }, [accountID]);

  const syncAll = useCallback(async () => {
    if (!session?.token || !accountID || syncLock.current || localMutation.current) return;
    syncLock.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await Network.getNetworkStateAsync();
      setNetworkState(state);
      if (!state.isConnected || state.isInternetReachable === false) {
        setSyncMessage("Offline — alterações pendentes serão mantidas neste dispositivo.");
        await reloadLocal();
        return;
      }
      setSyncMessage("Sincronizando...");
      const pending = await readPending(accountID);
      for (const change of pending) {
        const path = `/api/products/${change.product_id}`;
        try {
          if (change.operation === "create") {
            const created = await request("/api/products", {
              token: session.token, method: "POST", headers: { "Idempotency-Key": change.product_id },
              body: JSON.stringify(cleanProduct(change.payload)),
            });
            await migrateCreatedProduct(accountID, change.product_id, created);
          } else if (change.operation === "upsert") {
            const updated = await request(path, {
              token: session.token, method: "PUT",
              body: JSON.stringify({ ...cleanProduct(change.payload), version: change.base_version }),
            });
            await saveServerProduct(accountID, updated, change.product_id);
          } else {
            await request(path, {
              token: session.token, method: "DELETE",
              body: JSON.stringify({ confirmName: change.payload?.name ?? "", version: change.base_version }),
            });
            await removeServerProduct(accountID, change.product_id);
          }
        } catch (reason) {
          if (reason.status === 409 && reason.current) {
            await saveConflict(accountID, change.product_id, {
              local: change.payload, server: reason.current, operation: change.operation,
            });
            continue;
          }
          if (reason.status === 404 && change.operation === "upsert") {
            await saveConflict(accountID, change.product_id, {
              local: change.payload, server: null, operation: change.operation,
            });
            continue;
          }
          if (reason.status === 404 && change.operation === "delete") {
            await removeServerProduct(accountID, change.product_id);
            continue;
          }
          throw reason;
        }
      }
      const [remoteProducts, remoteCurrencies] = await Promise.all([
        request("/api/products", { token: session.token }),
        request("/api/currencies", { token: session.token }),
      ]);
      await saveCurrencies(accountID, remoteCurrencies);
      const unresolved = new Set((await readPending(accountID)).map((item) => item.product_id));
      const remoteIDs = new Set(remoteProducts.map((item) => String(item.id)));
      const previouslyCached = await readProducts(accountID);
      for (const local of previouslyCached) {
        if (!local.localKey.startsWith("local-") && !unresolved.has(local.localKey) && !remoteIDs.has(local.localKey)) {
          await removeServerProduct(accountID, local.localKey);
        }
      }
      for (const remote of remoteProducts) {
        if (!unresolved.has(String(remote.id))) await saveServerProduct(accountID, remote);
      }
      const local = await readProducts(accountID);
      const codes = [...new Set(local.map((product) => product.currency).filter((code) => code !== "BRL"))];
      if (codes.length) {
        const response = await request(`/api/rates?currencies=${codes.join(",")}`, { token: session.token });
        await saveRates(accountID, response.rates);
      }
      await reloadLocal();
      const remaining = await readPending(accountID);
      setSyncMessage(remaining.length ? `${remaining.length} alteração(ões) pendente(s) ou em conflito.` : "Sincronizado.");
    } catch (reason) {
      setError(reason.message);
      setSyncMessage("Falha na sincronização — alterações pendentes foram preservadas.");
      await reloadLocal();
    } finally {
      setBusy(false);
    }
  }, [session, accountID, reloadLocal]);
  syncRef.current = syncAll;

  useEffect(() => {
    let active = true;
    (async () => {
      await getDatabase();
      const stored = await SecureStore.getItemAsync("session");
      if (stored) {
        try {
          const value = JSON.parse(stored);
          if (active) setSession(value);
        } catch {
          await SecureStore.deleteItemAsync("session");
        }
      }
      const network = await Network.getNetworkStateAsync();
      if (active) {
        setNetworkState(network);
        setLoading(false);
      }
    })().catch((reason) => {
      if (active) {
        setError(reason.message);
        setLoading(false);
      }
    });
    const subscription = Network.addNetworkStateListener((state) => {
      setNetworkState(state);
      if (state.isConnected && state.isInternetReachable !== false) syncRef.current?.();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!session || !accountID) return;
    reloadLocal().then(() => syncAll()).catch((reason) => setError(reason.message));
  }, [session, accountID, reloadLocal, syncAll]);

  async function signOut() {
    if (syncLock.current || localMutation.current) return;
    await SecureStore.deleteItemAsync("session");
    setSession(null);
    setProducts([]);
    setSyncMessage("Desconectado.");
  }

  async function saveProduct(product) {
    if (syncLock.current) throw new Error("Aguarde a sincronização terminar antes de salvar.");
    localMutation.current = true;
    try {
      const clean = cleanProduct(product);
      const existing = product.localKey ? product : products.find((item) => item.id === product.id);
      await saveLocalProduct(accountID, clean, existing ?? null);
      setProducts(await readProducts(accountID));
      setEditing(null);
      setSyncMessage("Alteração salva neste dispositivo. Sincronização pendente.");
    } finally {
      localMutation.current = false;
    }
    const network = await Network.getNetworkStateAsync();
    setNetworkState(network);
    if (network.isConnected && network.isInternetReachable !== false) await syncAll();
  }

  async function deleteProduct(product) {
    if (syncLock.current) {
      setError("Aguarde a sincronização terminar antes de excluir.");
      return;
    }
    localMutation.current = true;
    try {
      await queueDelete(accountID, product);
      setProducts(await readProducts(accountID));
      setDeleteTarget(null);
      setDeleteName("");
      setSyncMessage("Exclusão salva neste dispositivo. Sincronização pendente.");
    } finally {
      localMutation.current = false;
    }
    const network = await Network.getNetworkStateAsync();
    setNetworkState(network);
    if (network.isConnected && network.isInternetReachable !== false) await syncAll();
  }

  async function chooseConflict(product, choice) {
    const conflict = product.conflict;
    if (!conflict) return;
    if (choice === "server") {
      if (conflict.server) await resolveServerVersion(accountID, product.localKey, conflict.server);
      else await removeServerProduct(accountID, product.localKey);
    } else if (conflict.operation === "delete") {
      await request(`/api/products/${conflict.server.id}`, {
        token: session.token, method: "DELETE",
        body: JSON.stringify({ confirmName: conflict.local.name, version: conflict.server.version }),
      });
      await removeServerProduct(accountID, product.localKey);
    } else if (!conflict.server) {
      const recreated = await request("/api/products", {
        token: session.token, method: "POST", body: JSON.stringify(cleanProduct(conflict.local)),
      });
      await migrateCreatedProduct(accountID, product.localKey, recreated);
    } else {
      const updated = await request(`/api/products/${conflict.server.id}`, {
        token: session.token, method: "PUT",
        body: JSON.stringify({ ...cleanProduct(conflict.local), version: conflict.server.version }),
      });
      await saveServerProduct(accountID, updated, product.localKey);
    }
    await clearPending(accountID, product.localKey);
    await reloadLocal();
    setSyncMessage("Conflito resolvido por sua escolha.");
  }

  async function changeStatus(product) {
    if (product.status === "sold") {
      Alert.alert("Retornar ao estoque", `Remover a data da venda de "${product.name}"?`, [
        { text: "Cancelar", style: "cancel" },
        { text: "Retornar", onPress: () => saveProduct({ ...product, status: "stock", saleDate: null }).catch((reason) => setError(reason.message)) },
      ]);
    } else {
      setEditing({ ...product, status: "sold", saleDate: todayString() });
    }
  }

  const visibleProducts = products.filter((product) =>
    !product.isDeletePending && (filter === "all" || product.status === filter));
  const conflicts = products.filter((product) => product.conflict);
  const pendingCount = products.filter((product) => product.isPending).length;

  if (loading) return <SafeAreaView style={styles.center}><Text style={styles.muted}>Carregando dados locais...</Text></SafeAreaView>;
  if (!session) return <AuthScreen onSession={setSession} />;
  return (
    <SafeAreaView style={styles.app}>
      <View style={styles.topbar}>
        <View><Text style={styles.brand}>Gestão de custos</Text><Text style={styles.username}>{session.user?.username}</Text></View>
        <Button title="Sair" kind="text" compact onPress={signOut} disabled={busy} />
      </View>
      <View style={styles.networkBanner} accessibilityLiveRegion="polite">
        <Text style={styles.networkText}>
          {offline ? "Offline" : "Conectado"} · {pendingCount} pendente(s)
        </Text>
        <Button title={busy ? "Sincronizando..." : "Sincronizar"} onPress={syncAll} disabled={busy} compact />
      </View>
      <Text style={styles.syncMessage} accessibilityLiveRegion="polite">{syncMessage}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
      <View style={styles.mainTabs}>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: page === "products" }} onPress={() => setPage("products")} style={[styles.mainTab, page === "products" && styles.mainTabSelected]}>
          <Text style={styles.mainTabText}>Produtos</Text>
        </Pressable>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: page === "analytics" }} onPress={() => setPage("analytics")} style={[styles.mainTab, page === "analytics" && styles.mainTabSelected]}>
          <Text style={styles.mainTabText}>Análises</Text>
        </Pressable>
      </View>
      {page === "products" ? (
        <>
          <View style={styles.listControls}>
            <View style={styles.filterRow}>
              {[["all", "Todos"], ["stock", "Estoque"], ["sold", "Vendidos"]].map(([key, title]) =>
                <Pressable key={key} onPress={() => setFilter(key)} style={[styles.filterButton, filter === key && styles.filterButtonSelected]}>
                  <Text style={styles.filterText}>{title}</Text>
                </Pressable>)}
            </View>
            <View style={styles.listTools}>
              <Button title={hiddenCosts ? "Revelar custos" : "Ocultar custos"} kind="secondary" compact onPress={() => setHiddenCosts(!hiddenCosts)} />
              <Button title={currencyView === "original" ? "Moeda original" : "BRL"} kind="secondary" compact onPress={() => setCurrencyView(currencyView === "original" ? "BRL" : "original")} />
              <Button title="+ Produto" compact onPress={() => setEditing(EMPTY_PRODUCT())} />
            </View>
            <Text style={styles.stateText}>Custos: {hiddenCosts ? "ocultos" : "visíveis"} · Moeda: {currencyView === "BRL" ? "BRL" : "original"}</Text>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {visibleProducts.length ? visibleProducts.map((product) => (
              <ProductCard key={product.localKey} product={product} hiddenCosts={hiddenCosts} currencyView={currencyView} rates={rates}
                onEdit={(item) => setEditing(item)} onDetail={(item) => setDetails(item)} onDelete={(item) => {
                  Alert.alert("Excluir produto", `Iniciar exclusão de "${item.name}"?`, [
                    { text: "Cancelar", style: "cancel" },
                    { text: "Continuar", onPress: () => { setDeleteTarget(item); setDeleteName(""); } },
                  ]);
                }} onStatus={changeStatus} />
            )) : <View style={styles.emptyState}><Text style={styles.emptyIcon}>◇</Text><Text style={styles.sectionTitle}>Nenhum produto nesta lista</Text><Text style={styles.muted}>Cadastre produtos para acompanhar custos e vendas.</Text></View>}
          </ScrollView>
        </>
      ) : <AnalyticsScreen products={products.filter((item) => !item.isDeletePending)} rates={rates} hiddenCosts={hiddenCosts}
        onToggleCosts={() => setHiddenCosts(!hiddenCosts)} />}
      {editing && <ProductEditor product={editing} currencies={currencies}
        onClose={() => setEditing(null)} onSave={saveProduct} saving={busy} />}
      {details && <DetailModal product={details} currencyView={currencyView} hiddenCosts={hiddenCosts} rates={rates}
        onClose={() => setDetails(null)} onEdit={() => { setEditing(details); setDetails(null); }} />}
      <Modal visible={Boolean(deleteTarget)} transparent animationType="fade" onRequestClose={() => setDeleteTarget(null)}>
        <View style={styles.overlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.heading}>Confirmação final</Text>
            <Text style={styles.muted}>A exclusão de "{deleteTarget?.name}" e seus custos é irreversível. Informe o nome do produto.</Text>
            <TextInput accessibilityLabel="Nome do produto para confirmar exclusão" style={styles.input} value={deleteName} onChangeText={setDeleteName} />
            <View style={styles.inlineButtons}>
              <Button title="Cancelar" kind="secondary" onPress={() => setDeleteTarget(null)} />
              <Button title="Excluir definitivamente" kind="danger" onPress={() => deleteTarget && deleteName === deleteTarget.name ? deleteProduct(deleteTarget) : setError("O nome informado não corresponde ao produto.")} />
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={conflicts.length > 0} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.overlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.heading}>Conflito de sincronização</Text>
            <Text style={styles.muted}>Foram encontradas versões diferentes. Nenhuma alteração foi descartada.</Text>
            {conflicts.map((product) => <View key={product.localKey} style={styles.conflictItem}>
              <Text style={styles.sectionTitle}>{product.name}</Text>
              <Text style={styles.muted}>Neste dispositivo: {conflictSummary(product.conflict.local)}</Text>
              <Text style={styles.muted}>No servidor: {conflictSummary(product.conflict.server)}</Text>
              <View style={styles.inlineButtons}>
                <Button title="Manter no dispositivo" compact onPress={() => chooseConflict(product, "local").catch((reason) => setError(reason.message))} />
                <Button title="Manter servidor" kind="secondary" compact onPress={() => chooseConflict(product, "server").catch((reason) => setError(reason.message))} />
              </View>
            </View>)}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#f5f6f4" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f5f6f4" },
  authScreen: { flex: 1, backgroundColor: "#f5f6f4", justifyContent: "center", padding: 22 },
  authCard: { backgroundColor: "#fff", borderRadius: 16, padding: 23, borderWidth: 1, borderColor: "#e3e8e2" },
  eyebrow: { color: "#75827b", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8 },
  title: { color: "#20392d", fontWeight: "800", fontSize: 28, marginBottom: 6 },
  heading: { color: "#243c30", fontSize: 20, fontWeight: "700", marginBottom: 8 },
  muted: { color: "#718078", fontSize: 12, lineHeight: 18 },
  username: { color: "#75827b", fontSize: 11, marginTop: 2 },
  brand: { color: "#20392d", fontSize: 17, fontWeight: "800" },
  topbar: { paddingHorizontal: 17, paddingTop: 8, paddingBottom: 9, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e6e9e5", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  networkBanner: { backgroundColor: "#eaf2eb", paddingHorizontal: 15, paddingVertical: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  networkText: { color: "#315b40", fontSize: 11, fontWeight: "600" },
  syncMessage: { color: "#718078", fontSize: 10, paddingHorizontal: 16, paddingVertical: 3, backgroundColor: "#eaf2eb" },
  errorText: { marginHorizontal: 14, marginVertical: 5, color: "#942c27", fontSize: 12, backgroundColor: "#fff0ef", padding: 10, borderRadius: 7 },
  mainTabs: { flexDirection: "row", paddingHorizontal: 17, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e4e9e4" },
  mainTab: { paddingVertical: 12, marginRight: 22, borderBottomWidth: 2, borderBottomColor: "transparent" },
  mainTabSelected: { borderBottomColor: "#247248" },
  mainTabText: { color: "#42604d", fontSize: 13, fontWeight: "600" },
  listControls: { backgroundColor: "#fff", paddingHorizontal: 14, paddingTop: 9, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#e6e9e5" },
  filterRow: { flexDirection: "row", backgroundColor: "#edf0ed", borderRadius: 8, padding: 3, alignSelf: "flex-start" },
  filterButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  filterButtonSelected: { backgroundColor: "#fff" },
  filterText: { fontSize: 11, color: "#506258", fontWeight: "600" },
  listTools: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", marginTop: 7, gap: 5 },
  stateText: { color: "#76837a", fontSize: 10, marginTop: 4 },
  content: { padding: 13, paddingBottom: 35, gap: 11 },
  analyticsControls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  button: { minHeight: 40, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#247248" },
  button_primary: { backgroundColor: "#247248" },
  button_secondary: { backgroundColor: "#e9eee9" },
  button_danger: { backgroundColor: "#fff0ef" },
  button_text: { backgroundColor: "transparent", paddingHorizontal: 6 },
  buttonCompact: { minHeight: 32, paddingHorizontal: 9, paddingVertical: 6 },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  secondaryText: { color: "#354b3d" },
  textButtonText: { color: "#247248" },
  field: { marginBottom: 12 },
  fieldLabel: { color: "#526258", fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: "#d6ddd6", borderRadius: 7, paddingHorizontal: 10, paddingVertical: 9, backgroundColor: "#fff", color: "#26352d", fontSize: 14 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  card: { backgroundColor: "#fff", borderRadius: 11, padding: 14, borderWidth: 1, borderColor: "#e3e8e2" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  productImage: { width: 50, height: 50, borderRadius: 7 },
  cardTitle: { flex: 1 },
  cardHeading: { color: "#293d31", fontSize: 16, fontWeight: "700", marginBottom: 5 },
  status: { alignSelf: "flex-start", overflow: "hidden", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: "700" },
  stock: { backgroundColor: "#e8f4eb", color: "#26714a" },
  sold: { backgroundColor: "#faf1df", color: "#8a5b16" },
  pendingTag: { fontSize: 10, color: "#8a5b16", backgroundColor: "#faf1df", padding: 5, borderRadius: 6 },
  observations: { color: "#63736a", fontSize: 12, marginTop: 9, lineHeight: 17 },
  valueRow: { flexDirection: "row", gap: 17, marginTop: 13, marginBottom: 10 },
  valueCell: { flex: 1, gap: 4 },
  valueText: { color: "#2b3d32", fontSize: 13, fontWeight: "700" },
  saleValue: { color: "#247248" },
  marketText: { color: "#5f6f65", fontSize: 11, marginVertical: 3 },
  dateText: { color: "#718078", fontSize: 10, marginVertical: 5 },
  inlineButtons: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 10, alignItems: "center" },
  emptyState: { alignItems: "center", paddingVertical: 45 },
  emptyIcon: { color: "#287149", fontSize: 32, marginBottom: 12 },
  modalSafe: { flex: 1, backgroundColor: "#f8faf8" },
  modalContent: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 35 },
  modalHeading: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 15 },
  pickerWrap: { borderWidth: 1, borderColor: "#d6ddd6", borderRadius: 7, backgroundColor: "#fff", marginBottom: 12, overflow: "hidden" },
  imageRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  preview: { width: 55, height: 55, borderRadius: 7 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#e8ece8", paddingTop: 13, marginTop: 4, marginBottom: 9 },
  sectionTitle: { color: "#2c4234", fontSize: 14, fontWeight: "700", marginBottom: 7 },
  costRow: { flexDirection: "row", gap: 7, marginBottom: 8, alignItems: "center" },
  costTitle: { flex: 1 },
  costPrice: { width: 95 },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 17, borderTopWidth: 1, borderTopColor: "#e8ece8", paddingTop: 14 },
  detailImage: { width: 100, height: 100, borderRadius: 10, marginBottom: 12 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#edf0ed" },
  detailValue: { color: "#293d31", fontSize: 12, fontWeight: "600", textAlign: "right", flexShrink: 1 },
  tabRow: { flexDirection: "row", flexWrap: "wrap", backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e6e0", marginBottom: 12 },
  tab: { paddingHorizontal: 11, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabSelected: { borderBottomColor: "#247248" },
  tabText: { color: "#66746b", fontSize: 11, fontWeight: "600" },
  tabTextSelected: { color: "#247248" },
  filterCard: { backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e3e8e2", padding: 13, marginBottom: 12 },
  filterInputs: { flexDirection: "row", gap: 8, marginTop: 8 },
  filterInput: { flex: 1, fontSize: 11 },
  metricCard: { backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e3e8e2", paddingHorizontal: 15, marginBottom: 12 },
  metric: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#edf0ed" },
  metricValue: { color: "#293d31", fontSize: 20, fontWeight: "700", marginVertical: 5 },
  metricCount: { color: "#829087", fontSize: 10 },
  lossText: { color: "#a3413b", fontSize: 12, fontWeight: "700", marginVertical: 6 },
  chartCard: { backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e3e8e2", padding: 15, alignItems: "center", marginBottom: 12 },
  chartWrapper: { alignItems: "center", justifyContent: "center", marginVertical: 7 },
  chartText: { color: "#53645a", fontSize: 11, marginVertical: 5 },
  chartLegend: { alignSelf: "stretch", gap: 5, marginTop: 5 },
  legendLine: { color: "#5e6d63", fontSize: 11 },
  overlay: { flex: 1, backgroundColor: "#14251dcc", justifyContent: "center", padding: 18 },
  confirmCard: { backgroundColor: "#fff", borderRadius: 13, padding: 18, maxHeight: "85%" },
  conflictBox: { marginTop: 7, padding: 10, borderRadius: 8, backgroundColor: "#fff7e6" },
  conflictTitle: { color: "#815816", fontSize: 12, fontWeight: "700", marginBottom: 3 },
  conflictItem: { marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#e9ede9" },
});
