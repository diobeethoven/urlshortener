package main

import (
	"log/slog"
	"os"
	"urlshortener/internal/api"
	"urlshortener/internal/cache"
	"urlshortener/internal/db"
)

func main() {
	// Initialize PostgreSQL store
	pgOpts := &db.StoreOptions{
		DSN:             "postgres://postgres:postgres@localhost:5432/urlshortener?sslmode=disable",
		MaxOpenConns:    25,
		MaxIdleConns:    5,
		ConnMaxLifetime: 30,
	}

	pgStore, err := db.NewPostgreSQLStore(pgOpts)
	if err != nil {
		slog.Error("failed to create PostgreSQL store", "error", err)
		os.Exit(1)
	}
	defer pgStore.Close()

	// Initialize Redis cacher
	redisCacher := cache.NewRedisCacher("localhost:6379", 0)

	// Initialize slog logger
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Initialize router and start server
	router := api.NewRouter(pgStore, redisCacher, logger)

	slog.Info("starting URL shortener server", "address", "0.0.0.0:8080")
	if err := api.StartServer(router, "0.0.0.0:8080"); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}