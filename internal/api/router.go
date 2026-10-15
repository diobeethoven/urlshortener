package api

import (
	"net/http"

	"urlshortener/internal/cache"
	"urlshortener/internal/db"
	"urlshortener/internal/service"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"log/slog"
)

// NewRouter creates a new HTTP router with routes
func NewRouter(store db.Store, cacher cache.Cacher, logger *slog.Logger) *mux.Router {
	s := service.NewService(store, cacher, logger)
	r := mux.NewRouter()

	// API routes
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/shorten", serviceWrap(s.HandleShorten, "POST", logger)).Methods("POST")
	api.HandleFunc("/shorten", serviceWrap(s.HandleShorten, "OPTIONS", logger)).Methods("OPTIONS")

	// Short code routes
	r.HandleFunc("/{code}", serviceWrap(s.HandleResolve, "GET", logger)).Methods("GET")
	r.HandleFunc("/{code}", serviceWrap(s.HandleResolve, "HEAD", logger)).Methods("HEAD")

	// CORS and headers
	r.Use(func(next http.Handler) http.Handler {
		return handlers.CORS(
			handlers.AllowedOrigins([]string{"*"}),
			handlers.AllowedMethods([]string{"GET", "POST", "OPTIONS"}),
			handlers.AllowedHeaders([]string{"Content-Type", "Authorization"}),
		)(next)
	})

	return r
}

// serviceWrap wraps service handlers with context and logging
func serviceWrap(fn func(http.ResponseWriter, *http.Request), method string, log *slog.Logger) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		log = log.With("method", method, "path", r.URL.Path)
		log.Info("request")
		fn(w, r.WithContext(ctx))
	}
}

// StartServer starts the HTTP server
func StartServer(r *mux.Router, addr string) error {
	srv := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	return srv.ListenAndServe()
}