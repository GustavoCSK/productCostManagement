package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/shopspring/decimal"
	"golang.org/x/crypto/argon2"
)

type application struct {
	db         *sql.DB
	tokenKey   []byte
	httpClient *http.Client
}

func (a *application) supportsCurrency(ctx context.Context, currency string) (bool, error) {
	if currency == "BRL" {
		return true, nil
	}
	var exists int
	err := a.db.QueryRowContext(ctx, "SELECT 1 FROM supported_currencies WHERE code = ?", currency).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

type account struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Email    string `json:"email,omitempty"`
}

type contextKey string

const accountContextKey contextKey = "account"

func New(db *sql.DB, tokenKey []byte, client *http.Client) *application {
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	return &application{db: db, tokenKey: tokenKey, httpClient: client}
}

func (a *application) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", a.register)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.Handle("GET /api/products", a.protect(a.listProducts))
	mux.Handle("POST /api/products", a.protect(a.createProduct))
	mux.Handle("GET /api/products/{id}", a.protect(a.getProduct))
	mux.Handle("PUT /api/products/{id}", a.protect(a.updateProduct))
	mux.Handle("DELETE /api/products/{id}", a.protect(a.deleteProduct))
	mux.Handle("POST /api/products/{id}/costs", a.protect(a.addCost))
	mux.Handle("PUT /api/products/{id}/costs/{costID}", a.protect(a.updateCost))
	mux.Handle("DELETE /api/products/{id}/costs/{costID}", a.protect(a.deleteCost))
	mux.Handle("GET /api/currencies", a.protect(a.listCurrencies))
	mux.Handle("GET /api/rates", a.protect(a.getRates))
	mux.Handle("GET /api/analytics", a.protect(a.analytics))
	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *application) protect(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok {
			writeError(w, http.StatusUnauthorized, "Autenticação necessária.")
			return
		}
		userID, err := a.readToken(token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Sessão inválida ou expirada.")
			return
		}
		ctx := context.WithValue(r.Context(), accountContextKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func userID(r *http.Request) int64 {
	id, _ := r.Context().Value(accountContextKey).(int64)
	return id
}

func (a *application) register(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := decodeBody(w, r, &input, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "Informe nome de usuário e senha válidos.")
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	input.Email = strings.TrimSpace(input.Email)
	if input.Username == "" || input.Password == "" || len(input.Username) > 100 {
		writeError(w, http.StatusBadRequest, "Informe nome de usuário e senha válidos.")
		return
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível criar a conta.")
		return
	}
	result, err := a.db.ExecContext(r.Context(),
		"INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)",
		input.Username, string(hash), nullableString(input.Email))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, http.StatusConflict, "Esse nome de usuário já está em uso.")
			return
		}
		writeError(w, http.StatusInternalServerError, "Não foi possível criar a conta.")
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível criar a conta.")
		return
	}
	a.writeSession(w, account{ID: id, Username: input.Username, Email: input.Email})
}

func (a *application) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeBody(w, r, &input, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "Informe nome de usuário e senha.")
		return
	}
	var user account
	var hash string
	var email sql.NullString
	err := a.db.QueryRowContext(r.Context(),
		"SELECT id, username, email, password_hash FROM users WHERE username = ?",
		strings.TrimSpace(input.Username)).Scan(&user.ID, &user.Username, &email, &hash)
	if err != nil || !verifyPassword(input.Password, hash) {
		writeError(w, http.StatusUnauthorized, "Nome de usuário ou senha inválidos.")
		return
	}
	user.Email = email.String
	a.writeSession(w, user)
}

func hashPassword(password string) (string, error) {
	const memory = 32 * 1024
	const iterations = 3
	const parallelism = 2
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, 32)
	return fmt.Sprintf("argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		memory, iterations, parallelism, hex.EncodeToString(salt), hex.EncodeToString(hash)), nil
}

func verifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" || parts[1] != "v=19" {
		return false
	}
	var memory, iterations, parallelism uint64
	for _, field := range strings.Split(parts[2], ",") {
		key, value, ok := strings.Cut(field, "=")
		if !ok {
			return false
		}
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return false
		}
		switch key {
		case "m":
			memory = parsed
		case "t":
			iterations = parsed
		case "p":
			parallelism = parsed
		default:
			return false
		}
	}
	if memory < 8*1024 || memory > 128*1024 || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 4 {
		return false
	}
	salt, saltErr := hex.DecodeString(parts[3])
	expected, hashErr := hex.DecodeString(parts[4])
	if saltErr != nil || hashErr != nil || len(salt) < 16 || len(expected) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, uint32(iterations), uint32(memory), uint8(parallelism), uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func (a *application) writeSession(w http.ResponseWriter, user account) {
	token, err := a.newToken(user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível iniciar a sessão.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}

func (a *application) newToken(id int64) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	payload := fmt.Sprintf("%d:%d:%s", id, time.Now().Add(24*time.Hour).Unix(), base64.RawURLEncoding.EncodeToString(nonce))
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	signature := hmac.New(sha256.New, a.tokenKey)
	_, _ = signature.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature.Sum(nil)), nil
}

func (a *application) readToken(token string) (int64, error) {
	encoded, suppliedSignature, ok := strings.Cut(token, ".")
	if !ok {
		return 0, errInvalid
	}
	signature := hmac.New(sha256.New, a.tokenKey)
	_, _ = signature.Write([]byte(encoded))
	expected := base64.RawURLEncoding.EncodeToString(signature.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(suppliedSignature)) {
		return 0, errInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return 0, errInvalid
	}
	parts := strings.Split(string(payload), ":")
	if len(parts) != 3 {
		return 0, errInvalid
	}
	id, idErr := strconv.ParseInt(parts[0], 10, 64)
	exp, expErr := strconv.ParseInt(parts[1], 10, 64)
	if idErr != nil || expErr != nil || id < 1 || time.Now().Unix() >= exp {
		return 0, errInvalid
	}
	return id, nil
}

func (a *application) listProducts(w http.ResponseWriter, r *http.Request) {
	query := "SELECT id FROM products WHERE user_id = ?"
	args := []any{userID(r)}
	if status := r.URL.Query().Get("status"); status != "" {
		if status != "stock" && status != "sold" {
			writeError(w, http.StatusBadRequest, "Filtro de situação inválido.")
			return
		}
		query += " AND status = ?"
		args = append(args, status)
	}
	query += " ORDER BY name COLLATE NOCASE"
	rows, err := a.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível consultar os produtos.")
		return
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível consultar os produtos.")
			return
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível consultar os produtos.")
		return
	}
	if err := rows.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível consultar os produtos.")
		return
	}
	products := make([]product, 0, len(ids))
	for _, id := range ids {
		item, err := a.loadProduct(r.Context(), userID(r), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível consultar os produtos.")
			return
		}
		products = append(products, item)
	}
	writeJSON(w, http.StatusOK, products)
}

func (a *application) getProduct(w http.ResponseWriter, r *http.Request) {
	item, err := a.loadProduct(r.Context(), userID(r), pathID(r, "id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Produto não encontrado.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível consultar o produto.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *application) createProduct(w http.ResponseWriter, r *http.Request) {
	var input productInput
	if err := decodeBody(w, r, &input, 8<<20); err != nil {
		writeError(w, http.StatusBadRequest, "Os dados do produto são inválidos.")
		return
	}
	input, err := validateProduct(input)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Revise os campos obrigatórios, datas, valores e imagem.")
		return
	}
	supported, err := a.supportsCurrency(r.Context(), input.Currency)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível validar a moeda do produto.")
		return
	}
	if !supported {
		writeError(w, http.StatusBadRequest, "Selecione uma moeda oferecida pela fonte de câmbio.")
		return
	}
	mutationID := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(mutationID) > 128 {
		writeError(w, http.StatusBadRequest, "Identificador de sincronização inválido.")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível cadastrar o produto.")
		return
	}
	defer tx.Rollback()
	if mutationID != "" {
		var existingID int64
		err := tx.QueryRowContext(r.Context(),
			"SELECT product_id FROM product_creations WHERE user_id = ? AND mutation_id = ?", userID(r), mutationID).Scan(&existingID)
		if err == nil {
			_ = tx.Rollback()
			item, loadErr := a.loadProduct(r.Context(), userID(r), existingID)
			if loadErr != nil {
				writeError(w, http.StatusInternalServerError, "Não foi possível concluir a sincronização.")
				return
			}
			writeJSON(w, http.StatusOK, item)
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "Não foi possível verificar a sincronização.")
			return
		}
	}
	result, err := tx.ExecContext(r.Context(), `
INSERT INTO products (user_id, name, image_data, observations, sale_price, market_value, currency, entry_date, status, sale_date)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		userID(r), input.Name, nullableString(input.ImageData), input.Observations,
		nullableAmount(input.SalePrice), nullableAmount(input.MarketValue), input.Currency,
		input.EntryDate, input.Status, nullableDate(input.SaleDate))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível cadastrar o produto.")
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível cadastrar o produto.")
		return
	}
	for _, item := range input.Costs {
		if _, err := tx.ExecContext(r.Context(),
			"INSERT INTO costs (product_id, title, price) VALUES (?, ?, ?)", id, item.Title, item.Price); err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível cadastrar os custos.")
			return
		}
	}
	if mutationID != "" {
		if _, err := tx.ExecContext(r.Context(),
			"INSERT INTO product_creations (user_id, mutation_id, product_id) VALUES (?, ?, ?)",
			userID(r), mutationID, id); err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível registrar a sincronização.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível cadastrar o produto.")
		return
	}
	item, err := a.loadProduct(r.Context(), userID(r), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Produto cadastrado, mas não foi possível consultá-lo.")
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *application) updateProduct(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "id")
	var input productInput
	if err := decodeBody(w, r, &input, 8<<20); err != nil {
		writeError(w, http.StatusBadRequest, "Os dados do produto são inválidos.")
		return
	}
	input, err := validateProduct(input)
	if err != nil || input.Version < 1 {
		writeError(w, http.StatusBadRequest, "Revise os campos obrigatórios, datas, valores e imagem.")
		return
	}
	supported, err := a.supportsCurrency(r.Context(), input.Currency)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível validar a moeda do produto.")
		return
	}
	if !supported {
		writeError(w, http.StatusBadRequest, "Selecione uma moeda oferecida pela fonte de câmbio.")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar o produto.")
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), `
UPDATE products SET name = ?, image_data = ?, observations = ?, sale_price = ?, market_value = ?,
currency = ?, entry_date = ?, status = ?, sale_date = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND user_id = ? AND version = ?`,
		input.Name, nullableString(input.ImageData), input.Observations, nullableAmount(input.SalePrice),
		nullableAmount(input.MarketValue), input.Currency, input.EntryDate, input.Status, nullableDate(input.SaleDate),
		id, userID(r), input.Version)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar o produto.")
		return
	}
	changed, err := result.RowsAffected()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar o produto.")
		return
	}
	if changed == 0 {
		_ = tx.Rollback()
		if _, err := a.loadProduct(r.Context(), userID(r), id); errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Produto não encontrado.")
			return
		}
		current, err := a.loadProduct(r.Context(), userID(r), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível verificar a versão do produto.")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"message": "O produto foi alterado em outro dispositivo.", "current": current})
		return
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM costs WHERE product_id = ?", id); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar os custos.")
		return
	}
	for _, item := range input.Costs {
		if _, err := tx.ExecContext(r.Context(),
			"INSERT INTO costs (product_id, title, price) VALUES (?, ?, ?)", id, item.Title, item.Price); err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível atualizar os custos.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar o produto.")
		return
	}
	current, err := a.loadProduct(r.Context(), userID(r), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Produto atualizado, mas não foi possível consultá-lo.")
		return
	}
	writeJSON(w, http.StatusOK, current)
}

func (a *application) deleteProduct(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ConfirmName string `json:"confirmName"`
		Version     int64  `json:"version"`
	}
	if err := decodeBody(w, r, &input, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "Confirme informando o nome do produto.")
		return
	}
	item, err := a.loadProduct(r.Context(), userID(r), pathID(r, "id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Produto não encontrado.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível excluir o produto.")
		return
	}
	if input.Version < 1 {
		writeError(w, http.StatusBadRequest, "A versão do produto é obrigatória.")
		return
	}
	if input.Version != item.Version {
		writeJSON(w, http.StatusConflict, map[string]any{"message": "O produto foi alterado em outro dispositivo.", "current": item})
		return
	}
	if input.ConfirmName != item.Name {
		writeError(w, http.StatusBadRequest, "O nome informado não corresponde ao produto.")
		return
	}
	result, err := a.db.ExecContext(r.Context(), "DELETE FROM products WHERE id = ? AND user_id = ? AND version = ?", item.ID, userID(r), input.Version)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível excluir o produto.")
		return
	}
	count, err := result.RowsAffected()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível excluir o produto.")
		return
	}
	if count == 0 {
		current, err := a.loadProduct(r.Context(), userID(r), item.ID)
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Produto não encontrado.")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Não foi possível verificar o produto.")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"message": "O produto foi alterado em outro dispositivo.", "current": current})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *application) addCost(w http.ResponseWriter, r *http.Request) {
	var input costInput
	if err := decodeBody(w, r, &input, 16*1024); err != nil || validateCost(&input) != nil {
		writeError(w, http.StatusBadRequest, "Informe título e preço válidos para o custo.")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível adicionar o custo.")
		return
	}
	defer tx.Rollback()
	id := pathID(r, "id")
	if err := bumpProductVersion(r.Context(), tx, id, userID(r)); err != nil {
		writeError(w, http.StatusNotFound, "Produto não encontrado.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), "INSERT INTO costs (product_id, title, price) VALUES (?, ?, ?)", id, input.Title, input.Price); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível adicionar o custo.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível adicionar o custo.")
		return
	}
	item, err := a.loadProduct(r.Context(), userID(r), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Custo salvo, mas não foi possível consultar o produto.")
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *application) updateCost(w http.ResponseWriter, r *http.Request) {
	var input costInput
	if err := decodeBody(w, r, &input, 16*1024); err != nil || validateCost(&input) != nil {
		writeError(w, http.StatusBadRequest, "Informe título e preço válidos para o custo.")
		return
	}
	item, err := a.changeCost(r, input, false)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Produto ou custo não encontrado.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível atualizar o custo.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *application) deleteCost(w http.ResponseWriter, r *http.Request) {
	item, err := a.changeCost(r, costInput{}, true)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Produto ou custo não encontrado.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível remover o custo.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *application) changeCost(r *http.Request, input costInput, remove bool) (product, error) {
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return product{}, err
	}
	defer tx.Rollback()
	productID, costID := pathID(r, "id"), pathID(r, "costID")
	var owns int
	if err := tx.QueryRowContext(ctx, "SELECT 1 FROM products WHERE id = ? AND user_id = ?", productID, userID(r)).Scan(&owns); err != nil {
		return product{}, err
	}
	if remove {
		result, err := tx.ExecContext(ctx, "DELETE FROM costs WHERE id = ? AND product_id = ?", costID, productID)
		if err != nil {
			return product{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed == 0 {
			return product{}, sql.ErrNoRows
		}
	} else {
		result, err := tx.ExecContext(ctx, "UPDATE costs SET title = ?, price = ? WHERE id = ? AND product_id = ?",
			input.Title, input.Price, costID, productID)
		if err != nil {
			return product{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed == 0 {
			return product{}, sql.ErrNoRows
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE products SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", productID); err != nil {
		return product{}, err
	}
	if err := tx.Commit(); err != nil {
		return product{}, err
	}
	return a.loadProduct(ctx, userID(r), productID)
}

func (a *application) loadProduct(ctx context.Context, ownerID, id int64) (product, error) {
	var item product
	var image, observations, salePrice, marketValue, saleDate sql.NullString
	err := a.db.QueryRowContext(ctx, `
SELECT id, name, image_data, observations, sale_price, market_value, currency, entry_date, status, sale_date, version
FROM products WHERE id = ? AND user_id = ?`, id, ownerID).Scan(
		&item.ID, &item.Name, &image, &observations, &salePrice, &marketValue,
		&item.Currency, &item.EntryDate, &item.Status, &saleDate, &item.Version)
	if err != nil {
		return product{}, err
	}
	item.ImageData = image.String
	item.Observations = observations.String
	item.SalePrice = nullStringPointer(salePrice)
	item.MarketValue = nullStringPointer(marketValue)
	item.SaleDate = nullStringPointer(saleDate)
	item.Costs = make([]cost, 0)
	rows, err := a.db.QueryContext(ctx, "SELECT id, title, price FROM costs WHERE product_id = ? ORDER BY id", item.ID)
	if err != nil {
		return product{}, err
	}
	defer rows.Close()
	total := decimal.Zero
	for rows.Next() {
		var entry cost
		if err := rows.Scan(&entry.ID, &entry.Title, &entry.Price); err != nil {
			return product{}, err
		}
		price, err := decimal.NewFromString(entry.Price)
		if err != nil {
			return product{}, err
		}
		total = total.Add(price)
		item.Costs = append(item.Costs, entry)
	}
	if err := rows.Err(); err != nil {
		return product{}, err
	}
	item.CostTotal = total.String()
	return item, nil
}

func bumpProductVersion(ctx context.Context, tx *sql.Tx, id, ownerID int64) error {
	result, err := tx.ExecContext(ctx,
		"UPDATE products SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
		id, ownerID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func validateCost(input *costInput) error {
	input.Title = strings.TrimSpace(input.Title)
	value, err := decimal.NewFromString(input.Price)
	if input.Title == "" || err != nil || value.IsNegative() {
		return errInvalid
	}
	input.Price = value.String()
	return nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableAmount(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableDate(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func pathID(r *http.Request, name string) int64 {
	id, _ := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errInvalid
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
