package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"productcostmanagement/internal/api"
)

func main() {
	dbPath := envOr("DATABASE_PATH", "data/products.db")
	if err := os.MkdirAll(directoryOf(dbPath), 0o700); err != nil {
		log.Fatal(err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := api.InitializeDatabase(ctx, db); err != nil {
		log.Fatal(err)
	}

	secret := os.Getenv("TOKEN_SECRET")
	if len(secret) < 32 {
		log.Fatal("TOKEN_SECRET must contain at least 32 characters")
	}

	app := api.New(db, []byte(secret), &http.Client{Timeout: 8 * time.Second})
	server := &http.Server{
		Addr:              envOr("LISTEN_ADDRESS", ":8080"),
		Handler:           app.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	certFile, keyFile := os.Getenv("TLS_CERT_FILE"), os.Getenv("TLS_KEY_FILE")
	if (certFile == "") != (keyFile == "") {
		log.Fatal("TLS_CERT_FILE and TLS_KEY_FILE must be provided together")
	}
	if certFile != "" {
		log.Printf("listening with TLS on %s", server.Addr)
		log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
	}
	if strings.EqualFold(os.Getenv("APP_ENV"), "production") {
		log.Fatal("TLS_CERT_FILE and TLS_KEY_FILE are required in production")
	}
	log.Printf("listening on %s; HTTP is enabled for local development only", server.Addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func directoryOf(path string) string {
	index := strings.LastIndexAny(path, `/\`)
	if index < 0 {
		return "."
	}
	return path[:index]
}
