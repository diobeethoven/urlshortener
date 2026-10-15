package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"urlshortener/internal/model"
	"urlshortener/internal/cache"
	"urlshortener/internal/db"

	"log/slog"
)

// Service handles URL shortening operations
type Service struct {
	store   db.Store
	cache   cache.Cacher
	logger  *slog.Logger
}

// NewService creates a new URL service
func NewService(store db.Store, cache cache.Cacher, logger *slog.Logger) *Service {
	return &Service{
		store:   store,
		cache:   cache,
		logger:  logger,
	}
}

// ShortenRequest represents the request to shorten a URL
type ShortenRequest struct {
	URL         string `json:"url" validate:"required,url"`
	CustomAlias string `json:"custom_alias,omitempty" validate:"omitempty,alphaunum,max=32"`
}

// ShortenResponse represents the response from shortening
type ShortenResponse struct {
	ShortCode string `json:"short_code"`
	URL       string `json:"url"`
	CreatedAt int64  `json:"created_at"`
}

// Shorten creates a new shortened URL
func (s *Service) Shorten(ctx context.Context, req *ShortenRequest) (*ShortenResponse, error) {
	// Try to use custom alias if provided
	shortCode := req.CustomAlias
	if shortCode == "" {
		// Generate unique code using distributed range allocation
		var err error
		shortCode, err = s.generateUniqueCode(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to generate unique code: %w", err)
		}
	}

	// Check if code already exists (idempotency)
	existing, err := s.store.GetURL(ctx, shortCode)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing URL: %w", err)
	}
	if existing != nil {
		// Return existing short code (idempotent)
		return &ShortenResponse{
			ShortCode: shortCode,
			URL:       existing.URL,
			CreatedAt: existing.CreatedAt,
		}, nil
	}

	// Create URL mapping
	now := time.Now().Unix()
	url := &model.URL{
		ShortCode: shortCode,
		URL:       req.URL,
		CreatedAt: now,
	}

	// Save to database
	err = s.store.SaveURL(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("failed to save URL: %w", err)
	}

	// Cache the mapping
	err = s.cache.Set(ctx, shortCode, url, 24*time.Hour)
	if err != nil {
		s.logger.Warn("failed to cache URL, continuing without cache", "error", err)
	}

	return &ShortenResponse{
		ShortCode: shortCode,
		URL:       req.URL,
		CreatedAt: now,
	}, nil
}

// generateUniqueCode generates a unique short code using distributed range allocation
func (s *Service) generateUniqueCode(ctx context.Context) (string, error) {
	// Use Redis INCR to atomically increment and get the counter
	n, err := s.cache.Client().Incr(ctx, "urlshort:counter").Result()
	if err != nil {
		return "", err
	}
	return model.Base62Encode(n), nil
}

// Resolve resolves a short code to the original URL
func (s *Service) Resolve(ctx context.Context, code string) (*model.URL, error) {
	// First check cache
	url, err := s.cache.Get(ctx, code)
	if err == nil && url != nil {
		return url, nil
	}

	// Fall back to database
	url, err = s.store.GetURL(ctx, code)
	if err != nil {
		return nil, err
	}
	if url == nil {
		return nil, nil
	}

	// Cache the result
	err = s.cache.Set(ctx, code, url, 24*time.Hour)
	if err != nil {
		s.logger.Warn("failed to cache URL resolution", "error", err)
	}

	return url, nil
}

// HandleShorten handles the POST /api/shorten endpoint
func (s *Service) HandleShorten(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ShortenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	resp, err := s.Shorten(r.Context(), &req)
	if err != nil {
		s.logger.Error("shorten failed", "error", err)
		http.Error(w, "Failed to shorten URL", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// HandleResolve handles the GET /{code} endpoint
func (s *Service) HandleResolve(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if code == "" {
		http.Error(w, "Code required", http.StatusBadRequest)
		return
	}

	url, err := s.Resolve(r.Context(), code)
	if err != nil {
		if url == nil {
			http.Error(w, "URL not found", http.StatusNotFound)
			return
		}
		s.logger.Error("resolve failed", "error", err, "code", code)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Location", url.URL)
	w.WriteHeader(http.StatusFound)
}