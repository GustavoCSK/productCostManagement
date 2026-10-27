package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

type rate struct {
	ToBRL string `json:"toBRL"`
	Date  string `json:"date"`
}

type ratesResult struct {
	Rates       map[string]rate `json:"rates"`
	Unavailable []string        `json:"unavailable"`
}

func (a *application) listCurrencies(w http.ResponseWriter, r *http.Request) {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.frankfurter.dev/v1/currencies", nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Não foi possível consultar as moedas disponíveis.")
		return
	}
	response, err := a.httpClient.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Não foi possível consultar as moedas disponíveis.")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, "Não foi possível consultar as moedas disponíveis.")
		return
	}
	var currencies map[string]string
	if err := json.NewDecoder(response.Body).Decode(&currencies); err != nil {
		writeError(w, http.StatusBadGateway, "A fonte de câmbio retornou dados inválidos.")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível salvar as moedas disponíveis.")
		return
	}
	defer tx.Rollback()
	for code, name := range currencies {
		if _, err := tx.ExecContext(r.Context(),
			"INSERT INTO supported_currencies (code, name) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name",
			code, name); err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível salvar as moedas disponíveis.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível salvar as moedas disponíveis.")
		return
	}
	writeJSON(w, http.StatusOK, currencies)
}

func (a *application) getRates(w http.ResponseWriter, r *http.Request) {
	currencies := parseCurrencies(r.URL.Query().Get("currencies"))
	if len(currencies) == 0 {
		writeError(w, http.StatusBadRequest, "Informe ao menos uma moeda.")
		return
	}
	result := a.ratesFor(r.Context(), currencies)
	writeJSON(w, http.StatusOK, result)
}

func parseCurrencies(raw string) []string {
	seen := map[string]bool{}
	currencies := make([]string, 0)
	for _, value := range strings.Split(raw, ",") {
		code := strings.ToUpper(strings.TrimSpace(value))
		if len(code) == 3 && !seen[code] {
			seen[code] = true
			currencies = append(currencies, code)
		}
	}
	sort.Strings(currencies)
	return currencies
}

func (a *application) ratesFor(ctx context.Context, currencies []string) ratesResult {
	result := ratesResult{Rates: make(map[string]rate), Unavailable: make([]string, 0)}
	today := time.Now().UTC().Format("2006-01-02")
	type workItem struct {
		currency string
		cached   rate
		hasCache bool
	}
	type resultItem struct {
		currency string
		value    rate
		err      error
		cached   rate
		hasCache bool
	}
	work := make([]workItem, 0, len(currencies))
	for _, currency := range currencies {
		if currency == "BRL" {
			result.Rates[currency] = rate{ToBRL: "1", Date: today}
			continue
		}
		cached, hasCached := a.cachedRate(ctx, currency)
		if hasCached && cached.Date >= today {
			result.Rates[currency] = cached
			continue
		}
		work = append(work, workItem{currency: currency, cached: cached, hasCache: hasCached})
	}
	results := make(chan resultItem, len(work))
	limit := make(chan struct{}, 4)
	for _, item := range work {
		go func(item workItem) {
			limit <- struct{}{}
			value, err := a.fetchRate(ctx, item.currency)
			<-limit
			results <- resultItem{
				currency: item.currency, value: value, err: err, cached: item.cached, hasCache: item.hasCache,
			}
		}(item)
	}
	for range work {
		fetched := <-results
		if fetched.err == nil {
			if _, err := a.db.ExecContext(ctx, `
INSERT INTO exchange_rates (currency, to_brl, rate_date) VALUES (?, ?, ?)
ON CONFLICT(currency) DO UPDATE SET to_brl = excluded.to_brl, rate_date = excluded.rate_date`,
				fetched.currency, fetched.value.ToBRL, fetched.value.Date); err != nil {
				log.Printf("cache exchange rate for %s: %v", fetched.currency, err)
			}
			result.Rates[fetched.currency] = fetched.value
			continue
		}
		if fetched.hasCache {
			result.Rates[fetched.currency] = fetched.cached
		} else {
			result.Unavailable = append(result.Unavailable, fetched.currency)
		}
	}
	sort.Strings(result.Unavailable)
	return result
}

func (a *application) cachedRate(ctx context.Context, currency string) (rate, bool) {
	var value rate
	err := a.db.QueryRowContext(ctx,
		"SELECT to_brl, rate_date FROM exchange_rates WHERE currency = ?", currency).Scan(&value.ToBRL, &value.Date)
	return value, err == nil
}

func (a *application) fetchRate(ctx context.Context, currency string) (rate, error) {
	endpoint := "https://api.frankfurter.dev/v1/latest?base=" + url.QueryEscape(currency) + "&symbols=BRL"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return rate{}, err
	}
	response, err := a.httpClient.Do(request)
	if err != nil {
		return rate{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return rate{}, fmt.Errorf("exchange source returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		Base  string                 `json:"base"`
		Date  string                 `json:"date"`
		Rates map[string]json.Number `json:"rates"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return rate{}, err
	}
	value, ok := payload.Rates["BRL"]
	parsed, parseErr := decimal.NewFromString(value.String())
	if !ok || parseErr != nil || !parsed.IsPositive() || payload.Base != currency || payload.Date == "" {
		return rate{}, fmt.Errorf("exchange source returned no valid BRL rate")
	}
	return rate{ToBRL: parsed.String(), Date: payload.Date}, nil
}

type analyticsResponse struct {
	View                string   `json:"view"`
	ProductCount        int      `json:"productCount"`
	CostProductCount    int      `json:"costProductCount"`
	ProfitProductCount  int      `json:"profitProductCount"`
	CostTotal           *string  `json:"costTotal"`
	ProfitCostTotal     *string  `json:"profitCostTotal"`
	Revenue             *string  `json:"revenue"`
	Profit              *string  `json:"profit"`
	ProfitStatus        string   `json:"profitStatus"`
	MarketProductCount  int      `json:"marketProductCount"`
	MarketDifference    *string  `json:"marketDifference"`
	MarketPercent       *string  `json:"marketPercent"`
	CurrencyUnavailable []string `json:"currencyUnavailable"`
}

func (a *application) analytics(w http.ResponseWriter, r *http.Request) {
	view := r.URL.Query().Get("view")
	if view != "stock" && view != "sold" && view != "all" {
		writeError(w, http.StatusBadRequest, "Visão de análise inválida.")
		return
	}
	products, err := a.loadAnalyticsProducts(r.Context(), userID(r), view, r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, "Filtros de data inválidos.")
		return
	}
	currencies := make([]string, 0)
	for _, item := range products {
		currencies = append(currencies, item.Currency)
	}
	availableRates := a.ratesFor(r.Context(), parseCurrencies(strings.Join(currencies, ",")))
	unavailable := make(map[string]bool, len(availableRates.Unavailable))
	for _, currency := range availableRates.Unavailable {
		unavailable[currency] = true
	}
	result := calculateAnalytics(view, products, availableRates.Rates, unavailable)
	writeJSON(w, http.StatusOK, result)
}

func (a *application) loadAnalyticsProducts(ctx context.Context, ownerID int64, view string, query url.Values) ([]product, error) {
	rows, err := a.db.QueryContext(ctx, "SELECT id FROM products WHERE user_id = ?", ownerID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	var month, year int
	if view == "sold" {
		if value := query.Get("month"); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 1 || parsed > 12 {
				return nil, errInvalid
			}
			month = parsed
		}
		if value := query.Get("year"); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < 1 || parsed > 9999 {
				return nil, errInvalid
			}
			year = parsed
		}
	}
	var fromDate, toDate time.Time
	if view == "sold" {
		if value := query.Get("from"); value != "" {
			fromDate, err = time.Parse("2006-01-02", value)
			if err != nil {
				return nil, errInvalid
			}
		}
		if value := query.Get("to"); value != "" {
			toDate, err = time.Parse("2006-01-02", value)
			if err != nil {
				return nil, errInvalid
			}
		}
		if !fromDate.IsZero() && !toDate.IsZero() && fromDate.After(toDate) {
			return nil, errInvalid
		}
	}

	result := make([]product, 0, len(ids))
	for _, id := range ids {
		item, err := a.loadProduct(ctx, ownerID, id)
		if err != nil {
			return nil, err
		}
		if view == "stock" && item.Status != "stock" {
			continue
		}
		if view == "sold" {
			if item.Status != "sold" || item.SaleDate == nil {
				continue
			}
			date, _ := time.Parse("2006-01-02", *item.SaleDate)
			if month > 0 && int(date.Month()) != month {
				continue
			}
			if year > 0 && date.Year() != year {
				continue
			}
			if !fromDate.IsZero() && date.Before(fromDate) {
				continue
			}
			if !toDate.IsZero() && date.After(toDate) {
				continue
			}
		}
		result = append(result, item)
	}
	return result, nil
}

func calculateAnalytics(view string, products []product, rates map[string]rate, unavailable map[string]bool) analyticsResponse {
	result := analyticsResponse{
		View: view, ProductCount: 0, CostProductCount: len(products), ProfitProductCount: 0,
		ProfitStatus: "unavailable", MarketProductCount: 0, CurrencyUnavailable: make([]string, 0),
	}
	costTotal, profitCostTotal, revenue := decimal.Zero, decimal.Zero, decimal.Zero
	costsKnown, profitCostsKnown, revenueKnown := true, true, true
	marketSales, marketReferences := decimal.Zero, decimal.Zero
	marketKnown := true
	usedCurrency := make(map[string]bool)
	for _, item := range products {
		financiallyIncluded := item.SalePrice != nil &&
			((view == "stock" && item.Status == "stock") || ((view == "sold" || view == "all") && item.Status == "sold"))
		if financiallyIncluded {
			result.ProductCount++
			result.ProfitProductCount++
		}
		marketIncluded := item.SalePrice != nil && item.MarketValue != nil
		if marketIncluded {
			result.MarketProductCount++
		}
		conversion, ok := rates[item.Currency]
		if !ok || unavailable[item.Currency] {
			costsKnown = false
			usedCurrency[item.Currency] = true
			if financiallyIncluded {
				profitCostsKnown = false
				revenueKnown = false
			}
			if marketIncluded {
				marketKnown = false
			}
			continue
		}
		costRate, err := decimal.NewFromString(conversion.ToBRL)
		if err != nil || costRate.IsNegative() {
			costsKnown = false
			usedCurrency[item.Currency] = true
			if financiallyIncluded {
				profitCostsKnown = false
				revenueKnown = false
			}
			if marketIncluded {
				marketKnown = false
			}
			continue
		}
		itemCost, err := decimal.NewFromString(item.CostTotal)
		if err != nil {
			costsKnown = false
			if financiallyIncluded {
				profitCostsKnown = false
			}
		} else {
			costTotal = costTotal.Add(itemCost.Mul(costRate))
			if financiallyIncluded {
				profitCostTotal = profitCostTotal.Add(itemCost.Mul(costRate))
			}
		}
		if financiallyIncluded && item.SalePrice != nil {
			salePrice, err := decimal.NewFromString(*item.SalePrice)
			if err != nil {
				revenueKnown = false
			} else {
				revenue = revenue.Add(salePrice.Mul(costRate))
			}
		}
		if marketIncluded && item.SalePrice != nil && item.MarketValue != nil {
			marketPrice, marketErr := decimal.NewFromString(*item.SalePrice)
			marketRef, refErr := decimal.NewFromString(*item.MarketValue)
			if marketErr != nil || refErr != nil {
				marketKnown = false
			} else {
				marketSales = marketSales.Add(marketPrice.Mul(costRate))
				marketReferences = marketReferences.Add(marketRef.Mul(costRate))
			}
		}
	}
	for currency := range usedCurrency {
		result.CurrencyUnavailable = append(result.CurrencyUnavailable, currency)
	}
	sort.Strings(result.CurrencyUnavailable)
	if costsKnown {
		value := costTotal.String()
		result.CostTotal = &value
	}
	if result.ProductCount == 0 {
		revenueKnown = false
		profitCostsKnown = false
	}
	if revenueKnown && result.ProductCount > 0 {
		value := revenue.String()
		result.Revenue = &value
	}
	if profitCostsKnown && revenueKnown && result.ProductCount > 0 {
		value := profitCostTotal.String()
		result.ProfitCostTotal = &value
		profit := revenue.Sub(profitCostTotal)
		formatted := profit.String()
		result.Profit = &formatted
		if profit.IsNegative() {
			result.ProfitStatus = "loss"
		} else if profit.IsPositive() {
			result.ProfitStatus = "profit"
		} else {
			result.ProfitStatus = "break-even"
		}
	}
	if marketKnown && result.MarketProductCount > 0 && !marketReferences.IsZero() {
		difference := marketSales.Sub(marketReferences)
		formatted := difference.String()
		result.MarketDifference = &formatted
		percentage := difference.Div(marketReferences).Mul(decimal.NewFromInt(100))
		value := percentage.String()
		result.MarketPercent = &value
	}
	return result
}
