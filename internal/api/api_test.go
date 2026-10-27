package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/shopspring/decimal"
	_ "modernc.org/sqlite"
)

func testApplication(t *testing.T) (*application, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := InitializeDatabase(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(db, []byte("a-test-secret-long-enough-for-hmac"), nil), db
}

func TestSoldAnalyticsFiltersByMonthYearAndDateRange(t *testing.T) {
	app, db := testApplication(t)
	userResult, err := db.ExecContext(t.Context(), "INSERT INTO users (username, password_hash) VALUES ('filter-test', 'unused')")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := userResult.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	rows := []struct{ name, saleDate string }{
		{"October first", "2026-10-04"},
		{"October later", "2026-10-21"},
		{"September", "2026-09-30"},
		{"Next year", "2027-10-04"},
	}
	for _, row := range rows {
		_, err := db.ExecContext(t.Context(), `
INSERT INTO products (user_id, name, currency, entry_date, status, sale_date)
VALUES (?, ?, 'BRL', '2026-01-01', 'sold', ?)`, owner, row.name, row.saleDate)
		if err != nil {
			t.Fatal(err)
		}
	}
	selected, err := app.loadAnalyticsProducts(t.Context(), owner, "sold", url.Values{
		"month": {"10"}, "year": {"2026"}, "from": {"2026-10-10"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0].Name != "October later" {
		t.Fatalf("unexpected filtered products: %+v", selected)
	}
	selected, err = app.loadAnalyticsProducts(t.Context(), owner, "all", url.Values{
		"month": {"9"}, "year": {"2026"},
	})
	if err != nil || len(selected) != 4 {
		t.Fatalf("all-period view applied sold filters: products=%d err=%v", len(selected), err)
	}
}

func performJSON(t *testing.T, handler http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func createAccount(t *testing.T, handler http.Handler, username string) string {
	t.Helper()
	response := performJSON(t, handler, http.MethodPost, "/api/auth/register", "", map[string]string{
		"username": username, "password": "password",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("register status = %d, body = %s", response.Code, response.Body)
	}
	var result struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Token == "" {
		t.Fatal("registration returned an empty token")
	}
	return result.Token
}

func TestProductOwnershipIsEnforced(t *testing.T) {
	app, _ := testApplication(t)
	handler := app.Routes()
	ownerToken := createAccount(t, handler, "owner")
	otherToken := createAccount(t, handler, "other")
	productBody := map[string]any{
		"name": "Product", "currency": "BRL", "entryDate": "2026-10-27", "status": "stock",
		"costs": []map[string]string{{"title": "Packaging", "price": "12.35"}},
	}
	created := performJSON(t, handler, http.MethodPost, "/api/products", ownerToken, productBody)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body)
	}
	var item product
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.CostTotal != "12.35" || len(item.Costs) != 1 {
		t.Fatalf("unexpected product response: %+v", item)
	}
	updated := performJSON(t, handler, http.MethodPut, "/api/products/"+decimal.NewFromInt(item.ID).String(), ownerToken,
		map[string]any{
			"name": item.Name, "currency": item.Currency, "entryDate": item.EntryDate, "status": item.Status,
			"observations": "Changed on web", "costs": []map[string]string{}, "version": item.Version,
		})
	if updated.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", updated.Code, updated.Body)
	}
	staleDelete := performJSON(t, handler, http.MethodDelete, "/api/products/"+decimal.NewFromInt(item.ID).String(), ownerToken,
		map[string]any{"confirmName": item.Name, "version": item.Version})
	if staleDelete.Code != http.StatusConflict {
		t.Fatalf("stale delete status = %d, want 409", staleDelete.Code)
	}
	response := performJSON(t, handler, http.MethodGet, "/api/products/"+decimal.NewFromInt(item.ID).String(), otherToken, nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("other account product read status = %d, want 404", response.Code)
	}
	path := "/api/products/" + decimal.NewFromInt(item.ID).String()
	for _, response := range []*httptest.ResponseRecorder{
		performJSON(t, handler, http.MethodPut, path, otherToken, map[string]any{
			"name": item.Name, "currency": item.Currency, "entryDate": item.EntryDate, "status": item.Status,
			"costs": []map[string]string{}, "version": item.Version,
		}),
		performJSON(t, handler, http.MethodDelete, path, otherToken, map[string]any{
			"confirmName": item.Name, "version": item.Version,
		}),
		performJSON(t, handler, http.MethodPost, path+"/costs", otherToken, map[string]string{
			"title": "Unauthorized", "price": "1",
		}),
	} {
		if response.Code != http.StatusNotFound {
			t.Fatalf("unauthorized operation status = %d, want 404; body=%s", response.Code, response.Body)
		}
	}
}

func TestOfflineProductCreationIsIdempotent(t *testing.T) {
	app, _ := testApplication(t)
	handler := app.Routes()
	token := createAccount(t, handler, "sync-owner")
	payload, err := json.Marshal(map[string]any{
		"name": "Offline product", "currency": "BRL", "entryDate": "2026-10-27", "status": "stock",
	})
	if err != nil {
		t.Fatal(err)
	}
	create := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/products", bytes.NewReader(payload))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "local-product-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	first, second := create(), create()
	if first.Code != http.StatusCreated || second.Code != http.StatusOK {
		t.Fatalf("create statuses = %d and %d, want 201 and 200", first.Code, second.Code)
	}
	var firstProduct, secondProduct product
	if err := json.Unmarshal(first.Body.Bytes(), &firstProduct); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondProduct); err != nil {
		t.Fatal(err)
	}
	if firstProduct.ID != secondProduct.ID {
		t.Fatalf("retry created a duplicate product: ids %d and %d", firstProduct.ID, secondProduct.ID)
	}
	list := performJSON(t, handler, http.MethodGet, "/api/products", token, nil)
	var products []product
	if err := json.Unmarshal(list.Body.Bytes(), &products); err != nil {
		t.Fatal(err)
	}
	if len(products) != 1 {
		t.Fatalf("retry produced %d products, want 1", len(products))
	}
}

func TestProductCurrencyMustBeOfferedByExchangeSource(t *testing.T) {
	app, db := testApplication(t)
	handler := app.Routes()
	token := createAccount(t, handler, "currency-owner")
	if _, err := db.ExecContext(t.Context(),
		"INSERT INTO supported_currencies (code, name) VALUES ('USD', 'United States Dollar')"); err != nil {
		t.Fatal(err)
	}
	createProduct := func(name, currency string) *httptest.ResponseRecorder {
		return performJSON(t, handler, http.MethodPost, "/api/products", token, map[string]any{
			"name": name, "currency": currency, "entryDate": "2026-10-27", "status": "stock",
		})
	}
	if response := createProduct("Supported", "USD"); response.Code != http.StatusCreated {
		t.Fatalf("supported currency status = %d, body = %s", response.Code, response.Body)
	}
	if response := createProduct("Unsupported", "XYZ"); response.Code != http.StatusBadRequest {
		t.Fatalf("unsupported currency status = %d, want 400", response.Code)
	}
}

func TestPasswordHashSupportsLongPasswordsAndLogin(t *testing.T) {
	app, db := testApplication(t)
	handler := app.Routes()
	password := strings.Repeat("correct-horse-", 12)
	registered := performJSON(t, handler, http.MethodPost, "/api/auth/register", "", map[string]string{
		"username": "long-password", "password": password,
	})
	if registered.Code != http.StatusOK {
		t.Fatalf("register status = %d, body = %s", registered.Code, registered.Body)
	}
	var hash string
	if err := db.QueryRowContext(t.Context(), "SELECT password_hash FROM users WHERE username = ?", "long-password").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hash, password) || !strings.HasPrefix(hash, "argon2id$") {
		t.Fatalf("password was not stored as an Argon2id hash")
	}
	loggedIn := performJSON(t, handler, http.MethodPost, "/api/auth/login", "", map[string]string{
		"username": "long-password", "password": password,
	})
	if loggedIn.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", loggedIn.Code, loggedIn.Body)
	}
}

func TestProductValidationAndSalesTransitions(t *testing.T) {
	base := productInput{
		Name: "Product", Currency: "BRL", EntryDate: "2026-10-27", Status: "stock",
		SaleDate: stringPointer("2026-10-26"),
	}
	valid, err := validateProduct(base)
	if err != nil {
		t.Fatalf("valid product rejected: %v", err)
	}
	if valid.SaleDate != nil {
		t.Fatal("returning a product to stock must clear its sale date")
	}
	base.Status = "sold"
	if _, err := validateProduct(base); err != nil {
		t.Fatalf("sold product with date rejected: %v", err)
	}
	base.SaleDate = nil
	if _, err := validateProduct(base); err == nil {
		t.Fatal("sold product without sale date was accepted")
	}
	negative := "-0.01"
	base.Status = "stock"
	base.SalePrice = &negative
	if _, err := validateProduct(base); err == nil {
		t.Fatal("negative sale price was accepted")
	}
}

func TestCalculateInventoryAnalyticsUsesRequiredProductSets(t *testing.T) {
	sale := "100"
	market := "80"
	products := []product{
		{Status: "stock", Currency: "USD", SalePrice: &sale, MarketValue: &market, CostTotal: "40"},
		{Status: "stock", Currency: "USD", CostTotal: "10"},
	}
	result := calculateAnalytics("stock", products, map[string]rate{
		"USD": {ToBRL: "5", Date: "2026-10-26"},
	}, map[string]bool{})
	assertDecimal(t, result.CostTotal, "250")
	assertDecimal(t, result.ProfitCostTotal, "200")
	assertDecimal(t, result.Revenue, "500")
	assertDecimal(t, result.Profit, "300")
	assertDecimal(t, result.MarketDifference, "100")
	assertDecimal(t, result.MarketPercent, "25")
	if result.CostProductCount != 2 || result.ProductCount != 1 || result.MarketProductCount != 1 {
		t.Fatalf("unexpected counts: %+v", result)
	}
}

func TestSoldAnalyticsExcludesProductsWithoutSalePriceFromProfit(t *testing.T) {
	sale := "100"
	products := []product{
		{Status: "sold", Currency: "BRL", SalePrice: &sale, CostTotal: "120"},
		{Status: "sold", Currency: "BRL", CostTotal: "50"},
	}
	result := calculateAnalytics("sold", products, map[string]rate{
		"BRL": {ToBRL: "1", Date: "2026-10-27"},
	}, map[string]bool{})
	assertDecimal(t, result.CostTotal, "170")
	assertDecimal(t, result.ProfitCostTotal, "120")
	assertDecimal(t, result.Revenue, "100")
	assertDecimal(t, result.Profit, "-20")
	if result.CostProductCount != 2 || result.ProfitProductCount != 1 || result.ProfitStatus != "loss" {
		t.Fatalf("unexpected sold analytics: %+v", result)
	}
}

func TestCostValidationRejectsMissingFieldsAndNegativeAmounts(t *testing.T) {
	for _, input := range []costInput{
		{Title: "", Price: "1"},
		{Title: "Cost", Price: ""},
		{Title: "Cost", Price: "-0.01"},
	} {
		if validateCost(&input) == nil {
			t.Fatalf("invalid cost accepted: %+v", input)
		}
	}
	input := costInput{Title: "  Materials  ", Price: "12.300"}
	if err := validateCost(&input); err != nil {
		t.Fatalf("valid cost rejected: %v", err)
	}
	if input.Title != "Materials" || input.Price != "12.3" {
		t.Fatalf("cost was not normalized: %+v", input)
	}
}

func TestUnavailableExchangeRateDoesNotBecomeZero(t *testing.T) {
	sale := "100"
	item := product{Status: "sold", Currency: "XYZ", SalePrice: &sale, CostTotal: "40"}
	result := calculateAnalytics("sold", []product{item}, nil, map[string]bool{"XYZ": true})
	if result.CostTotal != nil || result.Revenue != nil || result.Profit != nil {
		t.Fatalf("missing rate was treated as a numeric value: %+v", result)
	}
	if len(result.CurrencyUnavailable) != 1 || result.CurrencyUnavailable[0] != "XYZ" {
		t.Fatalf("missing currency not reported: %+v", result.CurrencyUnavailable)
	}
}

func TestMarketZeroReferenceIsUnavailable(t *testing.T) {
	sale, market := "25", "0"
	item := product{Status: "stock", Currency: "BRL", SalePrice: &sale, MarketValue: &market, CostTotal: "0"}
	result := calculateAnalytics("stock", []product{item}, map[string]rate{"BRL": {ToBRL: "1"}}, nil)
	if result.MarketDifference != nil || result.MarketPercent != nil {
		t.Fatalf("zero reference should make aggregate comparison unavailable: %+v", result)
	}
}

func assertDecimal(t *testing.T, actual *string, expected string) {
	t.Helper()
	if actual == nil {
		t.Fatalf("value unavailable, expected %s", expected)
	}
	got, err := decimal.NewFromString(*actual)
	if err != nil {
		t.Fatalf("invalid decimal %q: %v", *actual, err)
	}
	want := decimal.RequireFromString(expected)
	if !got.Equal(want) {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func stringPointer(value string) *string {
	return &value
}
