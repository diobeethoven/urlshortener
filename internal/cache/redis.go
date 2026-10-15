package cache

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-redis/redis/v8"
	"urlshortener/internal/model"
)

// Cacher defines the interface for URL caching operations
type Cacher interface {
	Get(ctx context.Context, key string) (*model.URL, error)
	Set(ctx context.Context, key string, value *model.URL, expiration time.Duration) error
	Client() *redis.Client
	Close() error
}

// RedisCacher implements Cacher using Redis
type RedisCacher struct {
	client *redis.Client
}

// NewRedisCacher creates a new Redis cacher
func NewRedisCacher(addr string, db int) *RedisCacher {
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		DB:       db,
		PoolSize: 100,
	})
	return &RedisCacher{client: client}
}

// Get retrieves a URL from cache
func (r *RedisCacher) Get(ctx context.Context, key string) (*model.URL, error) {
	val, err := r.client.Get(ctx, key).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, nil
		}
		return nil, err
	}

	var u model.URL
	if err := json.Unmarshal([]byte(val), &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// Set saves a URL to cache
func (r *RedisCacher) Set(ctx context.Context, key string, value *model.URL, expiration time.Duration) error {
	jsonVal, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return r.client.Set(ctx, key, jsonVal, expiration).Err()
}

// Client returns the underlying Redis client
func (r *RedisCacher) Client() *redis.Client {
	return r.client
}

// Close closes the Redis connection
func (r *RedisCacher) Close() error {
	return r.client.Close()
}