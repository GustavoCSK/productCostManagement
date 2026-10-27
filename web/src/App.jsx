import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import Decimal from "decimal.js";
import {
  convertToBRL,
  formatMoney,
  localDate,
  marketComparison,
} from "./finance.js";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";
const COLORS = ["#198754", "#df9a29"];
const emptyProduct = () => ({
  name: "",
  imageData: "",
  observations: "",
  salePrice: "",
  marketValue: "",
  currency: "BRL",
  entryDate: localDate(),
  status: "stock",
  saleDate: "",
  costs: [],
});

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? result.message ?? "A operação falhou.");
  return result;
}

function AuthScreen({ onSession }) {
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", email: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const session = await request(`/api/auth/${registering ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      localStorage.setItem("session", JSON.stringify(session));
      onSession(session);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <p className="eyebrow">GESTÃO DE CUSTOS</p>
        <h1>{registering ? "Criar conta" : "Entrar"}</h1>
        {error && <p className="alert error" role="alert">{error}</p>}
        <label>Nome de usuário
          <input required autoComplete="username" value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </label>
        <label>Senha
          <input required type="password" autoComplete={registering ? "new-password" : "current-password"}
            value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
        {registering && <label>E-mail (opcional)
          <input type="email" autoComplete="email" value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </label>}
        <button className="primary full" disabled={busy}>{busy ? "Aguarde..." : registering ? "Criar conta" : "Entrar"}</button>
        <button className="text-button full" type="button" onClick={() => { setRegistering(!registering); setError(""); }}>
          {registering ? "Já tenho uma conta" : "Criar uma conta"}
        </button>
      </form>
    </main>
  );
}

function ProductEditor({ product, currencies, onSave, onCancel, busy }) {
  const [form, setForm] = useState(product);
  const [newCost, setNewCost] = useState({ title: "", price: "" });
  const [error, setError] = useState("");
  const costTotal = useMemo(() => {
    try {
      return form.costs.reduce((sum, item) => sum.plus(item.price || 0), new Decimal(0)).toString();
    } catch {
      return null;
    }
  }, [form.costs]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateCost(index, key, value) {
    setForm((current) => ({
      ...current,
      costs: current.costs.map((cost, costIndex) => costIndex === index ? { ...cost, [key]: value } : cost),
    }));
  }

  async function selectImage(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("A imagem deve ter no máximo 5 MB.");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Formato aceito: JPEG, PNG ou WebP.");
      return;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
      reader.readAsDataURL(file);
    });
    update("imageData", data);
    setError("");
  }

  function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) return setError("Informe o nome do produto.");
    if (form.status === "sold" && !form.saleDate) return setError("Informe a data da venda.");
    if (form.costs.some((cost) => !cost.title.trim() || cost.price === "" || Number(cost.price) < 0)) {
      return setError("Cada custo precisa de título e preço não negativo.");
    }
    if ([form.salePrice, form.marketValue].some((value) => value !== "" && Number(value) < 0)) {
      return setError("Os valores monetários não podem ser negativos.");
    }
    onSave({
      ...form,
      name: form.name.trim(),
      salePrice: form.salePrice === "" ? null : form.salePrice,
      marketValue: form.marketValue === "" ? null : form.marketValue,
      saleDate: form.status === "sold" ? form.saleDate : null,
      costs: form.costs.map(({ title, price }) => ({ title: title.trim(), price: String(price) })),
    }).catch((reason) => setError(reason.message));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="editor modal" onSubmit={submit} aria-labelledby="editor-title">
        <div className="modal-heading">
          <div><p className="eyebrow">PRODUTO</p><h2 id="editor-title">{product.id ? "Editar produto" : "Novo produto"}</h2></div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onCancel}>×</button>
        </div>
        {error && <p className="alert error" role="alert">{error}</p>}
        <div className="form-grid">
          <label className="span-two">Nome
            <input required maxLength={200} value={form.name} onChange={(event) => update("name", event.target.value)} />
          </label>
          <label>Moeda
            <select value={form.currency} onChange={(event) => update("currency", event.target.value)}>
              {Object.entries(currencies).sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) =>
                <option key={code} value={code}>{code} — {name}</option>)}
              {!currencies[form.currency] && <option value={form.currency}>{form.currency}</option>}
            </select>
          </label>
          <label>Data de entrada
            <input type="date" required value={form.entryDate} onChange={(event) => update("entryDate", event.target.value)} />
          </label>
          <label>Preço de venda (opcional)
            <input type="number" min="0" step="any" value={form.salePrice ?? ""} onChange={(event) => update("salePrice", event.target.value)} />
          </label>
          <label>Valor de mercado (opcional)
            <input type="number" min="0" step="any" value={form.marketValue ?? ""} onChange={(event) => update("marketValue", event.target.value)} />
          </label>
          <label>Situação
            <select value={form.status} onChange={(event) => {
              const status = event.target.value;
              update("status", status);
              update("saleDate", status === "sold" ? form.saleDate || localDate() : "");
            }}>
              <option value="stock">Em estoque</option><option value="sold">Vendido</option>
            </select>
          </label>
          {form.status === "sold" && <label>Data da venda
            <input type="date" required value={form.saleDate || localDate()} onChange={(event) => update("saleDate", event.target.value)} />
          </label>}
          <label className="span-two">Observações (opcional)
            <textarea rows="3" value={form.observations} onChange={(event) => update("observations", event.target.value)} />
          </label>
          <label className="span-two">Imagem (JPEG, PNG ou WebP; até 5 MB)
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => selectImage(event.target.files?.[0])} />
            {form.imageData && <span className="image-actions">
              <img src={form.imageData} alt="Prévia da imagem do produto" />
              <button type="button" className="text-button" onClick={() => update("imageData", "")}>Remover imagem</button>
            </span>}
          </label>
        </div>
        <section className="cost-editor" aria-labelledby="cost-heading">
          <div className="section-heading"><h3 id="cost-heading">Custos</h3>
            <span>Total: {formatMoney(costTotal, form.currency)}</span>
          </div>
          {form.costs.map((cost, index) => <div className="cost-row" key={cost.id ?? index}>
            <label className="sr-only" htmlFor={`cost-title-${index}`}>Título do custo {index + 1}</label>
            <input id={`cost-title-${index}`} placeholder="Título" value={cost.title} onChange={(event) => updateCost(index, "title", event.target.value)} />
            <label className="sr-only" htmlFor={`cost-price-${index}`}>Preço do custo {index + 1}</label>
            <input id={`cost-price-${index}`} type="number" min="0" step="any" placeholder="Preço" value={cost.price} onChange={(event) => updateCost(index, "price", event.target.value)} />
            <button type="button" className="icon-button danger" aria-label={`Remover custo ${cost.title || index + 1}`}
              onClick={() => setForm((current) => ({ ...current, costs: current.costs.filter((_, costIndex) => costIndex !== index) }))}>×</button>
          </div>)}
          <div className="cost-row add-cost">
            <label className="sr-only" htmlFor="new-cost-title">Título do novo custo</label>
            <input id="new-cost-title" placeholder="Novo custo" value={newCost.title} onChange={(event) => setNewCost({ ...newCost, title: event.target.value })} />
            <label className="sr-only" htmlFor="new-cost-price">Preço do novo custo</label>
            <input id="new-cost-price" type="number" min="0" step="any" placeholder="Preço" value={newCost.price} onChange={(event) => setNewCost({ ...newCost, price: event.target.value })} />
            <button type="button" className="secondary" onClick={() => {
              if (!newCost.title.trim() || newCost.price === "" || Number(newCost.price) < 0) return setError("Informe título e preço não negativo para o custo.");
              setForm((current) => ({ ...current, costs: [...current.costs, { ...newCost }] }));
              setNewCost({ title: "", price: "" });
              setError("");
            }}>Adicionar</button>
          </div>
        </section>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>
          <button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar produto"}</button>
        </div>
      </form>
    </div>
  );
}

function ProductCard({ product, hiddenCosts, currencyView, rates, onEdit, onDelete, onStatus }) {
  const displayCurrency = currencyView === "BRL" ? "BRL" : product.currency;
  const cost = currencyView === "BRL" ? convertToBRL(product.costTotal, product.currency, rates) : product.costTotal;
  const market = marketComparison(product.salePrice, product.marketValue);
  return (
    <article className="product-card">
      <div className="product-photo">
        {product.imageData ? <img src={product.imageData} alt="" /> : <span aria-hidden="true">◇</span>}
      </div>
      <div className="product-main">
        <div className="product-title">
          <div><h3>{product.name}</h3><span className={`status ${product.status}`}>{product.status === "stock" ? "Em estoque" : "Vendido"}</span></div>
          <div className="inline-actions">
            <button className="text-button" onClick={() => onEdit(product, true)}>Detalhes</button>
            <button className="text-button" onClick={() => onEdit(product)}>Editar</button>
            <button className="text-button danger-text" onClick={() => onDelete(product)}>Excluir</button>
          </div>
        </div>
        {product.observations && <p className="observations">{product.observations}</p>}
        <div className="product-values">
          <p><span>Custo total</span><strong>{hiddenCosts ? "••••••" : formatMoney(cost, displayCurrency)}</strong></p>
          <p><span>Preço de venda</span><strong>{formatMoney(product.salePrice, displayCurrency)}</strong></p>
          {product.marketValue !== null && <p><span>Valor de mercado</span><strong>{formatMoney(currencyView === "BRL" ? convertToBRL(product.marketValue, product.currency, rates) : product.marketValue, displayCurrency)}</strong></p>}
        </div>
        {market && product.salePrice !== null && product.marketValue !== null && <p className="market-note">
          Preço {market.position} da referência em {formatMoney(new Decimal(market.difference).abs().toString(), product.currency)}
          {" "}({new Decimal(market.percentage).toFixed(2)}%)
        </p>}
        <div className="product-dates">
          <span>Entrada: {product.entryDate}</span>
          {product.status === "sold" && <span>Venda: {product.saleDate}</span>}
        </div>
        <button className="status-action" onClick={() => onStatus(product)}>
          {product.status === "stock" ? "Registrar venda" : "Retornar ao estoque"}
        </button>
      </div>
    </article>
  );
}

function ProductDetails({ product, hiddenCosts, onEdit, onClose }) {
  if (!product) return null;
  const market = marketComparison(product.salePrice, product.marketValue);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="details modal" role="dialog" aria-modal="true" aria-labelledby="details-title">
        <div className="modal-heading">
          <div><p className="eyebrow">DETALHES DO PRODUTO</p><h2 id="details-title">{product.name}</h2></div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>×</button>
        </div>
        {product.imageData && <img className="details-image" src={product.imageData} alt={`Imagem de ${product.name}`} />}
        <dl className="details-grid">
          <div><dt>Situação</dt><dd>{product.status === "stock" ? "Em estoque" : "Vendido"}</dd></div>
          <div><dt>Moeda</dt><dd>{product.currency}</dd></div>
          <div><dt>Data de entrada</dt><dd>{product.entryDate}</dd></div>
          {product.status === "sold" && <div><dt>Data da venda</dt><dd>{product.saleDate}</dd></div>}
          <div><dt>Custo total</dt><dd>{hiddenCosts ? "••••••" : formatMoney(product.costTotal, product.currency)}</dd></div>
          <div><dt>Preço de venda</dt><dd>{formatMoney(product.salePrice, product.currency)}</dd></div>
          <div><dt>Valor de mercado</dt><dd>{formatMoney(product.marketValue, product.currency)}</dd></div>
          <div className="details-observations"><dt>Observações</dt><dd>{product.observations || "Não informado"}</dd></div>
        </dl>
        {market && product.salePrice !== null && product.marketValue !== null && <p className="market-note">
          Preço {market.position} da referência em {new Decimal(market.difference).abs().toString()} {product.currency}
          {" "}({new Decimal(market.percentage).toFixed(2)}%).
        </p>}
        <section className="details-costs" aria-labelledby="details-cost-title">
          <h3 id="details-cost-title">Custos individuais</h3>
          {product.costs.length ? <ul>
            {product.costs.map((cost) => <li key={cost.id}>
              <span>{cost.title}</span><strong>{hiddenCosts ? "••••••" : formatMoney(cost.price, product.currency)}</strong>
            </li>)}
          </ul> : <p className="muted">Nenhum custo cadastrado.</p>}
        </section>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Fechar</button>
          <button className="primary" onClick={onEdit}>Editar produto</button>
        </div>
      </section>
    </div>
  );
}

function Analytics({ token, hiddenCosts, onToggleCosts }) {
  const [view, setView] = useState("stock");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ view });
    if (view === "sold") {
      if (month) params.set("month", month);
      if (year) params.set("year", year);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    }
    return params.toString();
  }, [view, month, year, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await request(`/api/analytics?${query}`, { token });
      setData(result);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }, [query, token]);

  useEffect(() => { load(); }, [load]);
  const chartData = data?.profit && new Decimal(data.profit).isPositive()
    ? [{ name: "Custos", value: Number(data.profitCostTotal) }, { name: "Lucro", value: Number(data.profit) }]
    : data?.profitCostTotal ? [{ name: "Custos", value: Number(data.profitCostTotal) }] : [];
  return (
    <section className="analytics">
      <div className="analytics-tabs" role="tablist" aria-label="Visões de análise">
        {[["stock", "Estoque atual"], ["sold", "Vendidos"], ["all", "Todo o período"]].map(([key, title]) =>
          <button key={key} role="tab" aria-selected={view === key} className={view === key ? "active" : ""}
            onClick={() => setView(key)}>{title}</button>)}
      </div>
      <div className="analytics-controls">
        <button className="toggle-control" aria-pressed={hiddenCosts} onClick={onToggleCosts}>
            {hiddenCosts ? "Revelar custos" : "Ocultar custos"} <span className="state">{hiddenCosts ? "Ocultos" : "Visíveis"}</span>
        </button>
      </div>
      {view === "sold" && <div className="filter-bar">
        <label>Mês <select value={month} onChange={(event) => setMonth(event.target.value)}>
          <option value="">Todos</option>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{new Date(2000, index).toLocaleString("pt-BR", { month: "long" })}</option>)}
        </select></label>
        <label>Ano <input aria-label="Ano" type="number" min="1" value={year} onChange={(event) => setYear(event.target.value)} placeholder="Todos" /></label>
        <label>De <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Até <input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>}
      {error && <p className="alert error" role="alert">{error}</p>}
      {loading && <p role="status">Atualizando análises...</p>}
      {data && !loading && <div className="analysis-grid">
        <div className="metric-list">
          <Metric label={view === "stock" ? "Custo total do estoque" : "Despesas / custos"} value={data.costTotal} count={data.costProductCount} hiddenValue={hiddenCosts} />
          <Metric label={view === "stock" ? "Receita estimada" : "Receita"} value={data.revenue} count={data.profitProductCount} />
          <Metric label={data.profitStatus === "loss" ? "Prejuízo" : view === "stock" ? "Lucro estimado" : "Lucro"} value={data.profit === null && data.profitStatus === "unavailable" ? null : data.profit} count={data.profitProductCount} />
          <Metric label="Diferença para o mercado" value={data.marketDifference} count={data.marketProductCount} suffix={data.marketPercent === null ? "" : ` (${new Decimal(data.marketPercent).toFixed(2)}%)`} />
          {data.profitStatus === "loss" && <p className="loss-note">O conjunto analisado apresenta prejuízo.</p>}
          {data.currencyUnavailable?.length > 0 && <p className="muted">Taxas indisponíveis: {data.currencyUnavailable.join(", ")}.</p>}
        </div>
        <div className="chart-card">
          <h3>Custos e resultado</h3>
          {chartData.length ? <>
            <div className="pie-chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={chartData} dataKey="value" nameKey="name" outerRadius="82%">
                    {chartData.map((item, index) => <Cell key={item.name} fill={COLORS[index]} />)}
                  </Pie>
                  <Tooltip formatter={(value, name) => [hiddenCosts && name === "Custos" ? "••••••" : formatMoney(value, "BRL"), name]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <p className="chart-caption">Receita total considerada: <strong>{formatMoney(data.revenue, "BRL")}</strong></p>
          </> : <p className="muted">Dados insuficientes para o gráfico.</p>}
          <ul className="chart-legend">
            {chartData.map((item, index) => <li key={item.name}><span style={{ background: COLORS[index] }} />{item.name}: {hiddenCosts && item.name === "Custos" ? "••••••" : formatMoney(item.value, "BRL")}</li>)}
          </ul>
        </div>
      </div>}
      <p className="muted">Valores de análise em BRL. As taxas mais recentes disponíveis são aplicadas também aos registros históricos.</p>
    </section>
  );
}

function Metric({ label, value, count, suffix = "", hiddenValue = false }) {
  const formatted = hiddenValue ? "••••••" : value === null ? "Não disponível" : formatMoney(value, "BRL");
  return <div className="metric">
    <span>{label}</span><strong>{formatted}{suffix}</strong>
    <small>{count} {count === 1 ? "produto considerado" : "produtos considerados"}</small>
  </div>;
}

export default function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem("session") ?? "null"); } catch { return null; }
  });
  const [page, setPage] = useState("products");
  const [products, setProducts] = useState([]);
  const [currencies, setCurrencies] = useState({});
  const [rates, setRates] = useState({});
  const [filter, setFilter] = useState("all");
  const [currencyView, setCurrencyView] = useState("original");
  const [hiddenCosts, setHiddenCosts] = useState(false);
  const [editor, setEditor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadData = useCallback(async () => {
    if (!session?.token) return;
    setLoading(true);
    setError("");
    try {
      const items = await request("/api/products", { token: session.token });
      setProducts(items);
      let currencyList = {};
      try {
        currencyList = await request("/api/currencies", { token: session.token });
        setCurrencies(currencyList);
      } catch {
        setError("A lista de moedas está temporariamente indisponível.");
      }
      const requested = [...new Set(items.map((item) => item.currency).filter((code) => code !== "BRL"))];
      if (requested.length) {
        const latest = await request(`/api/rates?currencies=${requested.join(",")}`, { token: session.token });
        setRates(latest.rates ?? {});
      }
    } catch (reason) {
      setError(reason.message || "Não foi possível consultar os dados. Verifique a conexão.");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadData(); }, [loadData]);

  async function saveProduct(product) {
    setSaving(true);
    setError("");
    try {
      let saved;
      if (product.id) {
        saved = await request(`/api/products/${product.id}`, {
          token: session.token, method: "PUT", body: JSON.stringify({ ...product, version: product.version }),
        });
      } else {
        saved = await request("/api/products", { token: session.token, method: "POST", body: JSON.stringify(product) });
      }
      setProducts((current) => product.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setEditor(null);
      setNotice("Produto salvo.");
    } catch (reason) {
      throw reason;
    } finally {
      setSaving(false);
    }
  }

  async function deleteProduct(product) {
    if (!window.confirm(`Excluir "${product.name}"? Esta ação não pode ser desfeita.`)) return;
    const typed = window.prompt(`Para confirmar a exclusão irreversível, informe o nome do produto: ${product.name}`);
    if (typed === null) return;
    try {
      await request(`/api/products/${product.id}`, {
        token: session.token, method: "DELETE",
        body: JSON.stringify({ confirmName: typed, version: product.version }),
      });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      setNotice("Produto excluído.");
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function changeStatus(product) {
    if (product.status === "sold") {
      if (!window.confirm(`Retornar "${product.name}" ao estoque? A data da venda será removida.`)) return;
      await saveProduct({ ...product, status: "stock", saleDate: null }).catch((reason) => setError(reason.message));
      return;
    }
    setEditor({ ...product, status: "sold", saleDate: localDate() });
  }

  const visibleProducts = products.filter((item) => filter === "all" || item.status === filter);
  const refreshRates = async () => {
    const requested = [...new Set(products.map((item) => item.currency).filter((code) => code !== "BRL"))];
    if (!requested.length) return;
    try {
      const latest = await request(`/api/rates?currencies=${requested.join(",")}`, { token: session.token });
      setRates(latest.rates ?? {});
    } catch (reason) {
      setError(reason.message);
    }
  };

  if (!session?.token) return <AuthScreen onSession={setSession} />;
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("products"); }}>
          <span className="brand-mark">PC</span><span>Gestão de custos</span>
        </a>
        <div className="user-area"><span>{session.user?.username}</span>
          <button className="text-button" onClick={() => { localStorage.removeItem("session"); setSession(null); }}>Sair</button>
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div><p className="eyebrow">PRODUTOS E RESULTADOS</p><h1>{page === "products" ? "Produtos" : "Análises"}</h1></div>
          {page === "products" && <button className="primary" onClick={() => setEditor(emptyProduct())}>+ Novo produto</button>}
        </div>
        <nav className="main-tabs" aria-label="Navegação principal">
          <button className={page === "products" ? "active" : ""} onClick={() => setPage("products")}>Produtos</button>
          <button className={page === "analytics" ? "active" : ""} onClick={() => setPage("analytics")}>Análises</button>
        </nav>
        {error && <p className="alert error" role="alert">{error}</p>}
        {notice && <p className="alert success" role="status">{notice}<button className="close-alert" aria-label="Fechar aviso" onClick={() => setNotice("")}>×</button></p>}
        {loading && <p className="loading" role="status">Carregando dados...</p>}
        {page === "products" ? <>
          <div className="product-controls">
            <div className="filter-tabs" aria-label="Filtrar produtos">
              {[["all", "Todos"], ["stock", "Em estoque"], ["sold", "Vendidos"]].map(([key, title]) =>
                <button key={key} className={filter === key ? "selected" : ""} onClick={() => setFilter(key)}>{title}</button>)}
            </div>
            <div className="view-controls">
              <button className="toggle-control" aria-pressed={hiddenCosts} onClick={() => setHiddenCosts(!hiddenCosts)}>
                {hiddenCosts ? "Revelar custos" : "Ocultar custos"} <span className="state">{hiddenCosts ? "Ocultos" : "Visíveis"}</span>
              </button>
              <label>Moeda da lista
                <select value={currencyView} onChange={(event) => setCurrencyView(event.target.value)}>
                  <option value="original">Original</option><option value="BRL">BRL</option>
                </select>
              </label>
              <button className="secondary compact" onClick={refreshRates}>Atualizar câmbio</button>
            </div>
          </div>
          {visibleProducts.length ? <div className="product-list">
            {visibleProducts.map((item) => <ProductCard key={item.id} product={item} hiddenCosts={hiddenCosts} currencyView={currencyView} rates={rates}
              onEdit={(product, showDetails = false) => showDetails ? setDetail(product) : setEditor(product)}
              onDelete={deleteProduct} onStatus={changeStatus} />)}
          </div> : !loading && <div className="empty-state"><span>◇</span><h2>Nenhum produto nesta lista</h2><p>Cadastre produtos para acompanhar custos e vendas.</p></div>}
        </> : <Analytics token={session.token} hiddenCosts={hiddenCosts} onToggleCosts={() => setHiddenCosts(!hiddenCosts)} />}
      </main>
      {editor && <ProductEditor product={editor} currencies={currencies} onSave={saveProduct} onCancel={() => setEditor(null)} busy={saving} />}
      {detail && <ProductDetails product={detail} hiddenCosts={hiddenCosts} onClose={() => setDetail(null)}
        onEdit={() => { setEditor(detail); setDetail(null); }} />}
    </div>
  );
}
