package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"urlshortener/internal/model"
)

// PostgreSQLStore implements Store using PostgreSQL
type PostgreSQLStore struct {
	conn   *sql.DB
	closed bool
}

// NewPostgreSQLStore creates a new PostgreSQL store
func NewPostgreSQLStore(opts *StoreOptions) (*PostgreSQLStore, error) {
	conn, err := sql.Open("pgx", opts.DSN)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	conn.SetMaxOpenConns(opts.MaxOpenConns)
	conn.SetMaxIdleConns(opts.MaxIdleConns)
	conn.SetConnMaxLifetime(time.Duration(opts.ConnMaxLifetime) * time.Minute)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Create tables
	if err := createTables(conn); err != nil {
		return nil, fmt.Errorf("failed to create tables: %w", err)
	}

	return &PostgreSQLStore{conn: conn}, nil
}

func createTables(conn *sql.DB) error {
	query := `
	CREATE TABLE IF NOT EXISTS urls (
		id SERIAL PRIMARY KEY,
		short_code VARCHAR(10) UNIQUE NOT NULL,
		url TEXT NOT NULL,
		created_at BIGINT NOT NULL,
		expires_at BIGINT,
		click_count INTEGER DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
	CREATE INDEX IF NOT EXISTS idx_urls_created_at ON urls(created_at);
	`
	_, err := conn.Exec(query)
	return err
}

// GetURL retrieves a URL by its short code
func (s *PostgreSQLStore) GetURL(ctx context.Context, code string) (*model.URL, error) {
	query := `SELECT id, short_code, url, created_at, expires_at, click_count FROM urls WHERE short_code = $1`
	row := s.conn.QueryRowContext(ctx, query, code)

	var u model.URL
	var expiresAt sql.NullInt64
	err := row.Scan(&u.ID, &u.ShortCode, &u.URL, &u.CreatedAt, &expiresAt, &u.ClickCount)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}

	if expiresAt.Valid {
		u.ExpiresAt = expiresAt.Int64
	}

	return &u, nil
}

// SaveURL saves a URL mapping
func (s *PostgreSQLStore) SaveURL(ctx context.Context, url *model.URL) error {
	query := `INSERT INTO urls (short_code, url, created_at, expires_at, click_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (short_code) DO NOTHING`
	_, err := s.conn.ExecContext(ctx, query, url.ShortCode, url.URL, url.CreatedAt, url.ExpiresAt, url.ClickCount)
	return err
}

// Close closes the database connection
func (s *PostgreSQLStore) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.conn.Close()
}