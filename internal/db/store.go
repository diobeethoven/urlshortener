package db

import (
	"context"
	"urlshortener/internal/model"
)

// Store defines the interface for URL storage operations
type Store interface {
	GetURL(ctx context.Context, code string) (*model.URL, error)
	SaveURL(ctx context.Context, url *model.URL) error
	Close() error
}

// StoreOptions contains options for creating a store
type StoreOptions struct {
	DSN             string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime int
}