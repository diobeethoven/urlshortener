package model

// URL represents a shortened URL mapping
type URL struct {
	ID        string `json:"id"`
	ShortCode string `json:"short_code"`
	URL       string `json:"url"`
	CreatedAt int64  `json:"created_at"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	ClickCount int   `json:"click_count,omitempty"`
}

// Base62 encoding characters
var base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Base62 encodes an integer to a base62 string
func Base62Encode(id int64) string {
	if id == 0 {
		return string(base62Chars[0])
	}
	var result string
	for id > 0 {
		result = string(base62Chars[id%62]) + result
		id /= 62
	}
	return result
}

// Base62Decode decodes a base62 string to an integer
func Base62Decode(s string) (int64, bool) {
	var id int64
	for _, c := range s {
		var v int64
		if c >= '0' && c <= '9' {
			v = int64(c - '0')
		} else if c >= 'A' && c <= 'Z' {
			v = int64(c - 'A') + 10
		} else if c >= 'a' && c <= 'z' {
			v = int64(c - 'a') + 36
		} else {
			return 0, false
		}
		id = id*62 + v
	}
	return id, true
}