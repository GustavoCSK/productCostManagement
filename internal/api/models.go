package api

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/shopspring/decimal"
)

var errInvalid = errors.New("invalid request")

type productInput struct {
	Name         string      `json:"name"`
	ImageData    string      `json:"imageData"`
	Observations string      `json:"observations"`
	SalePrice    *string     `json:"salePrice"`
	MarketValue  *string     `json:"marketValue"`
	Currency     string      `json:"currency"`
	EntryDate    string      `json:"entryDate"`
	Status       string      `json:"status"`
	SaleDate     *string     `json:"saleDate"`
	Costs        []costInput `json:"costs"`
	Version      int64       `json:"version"`
}

type costInput struct {
	Title string `json:"title"`
	Price string `json:"price"`
}

type cost struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
	Price string `json:"price"`
}

type product struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	ImageData    string  `json:"imageData,omitempty"`
	Observations string  `json:"observations"`
	SalePrice    *string `json:"salePrice"`
	MarketValue  *string `json:"marketValue"`
	Currency     string  `json:"currency"`
	EntryDate    string  `json:"entryDate"`
	Status       string  `json:"status"`
	SaleDate     *string `json:"saleDate"`
	Version      int64   `json:"version"`
	Costs        []cost  `json:"costs"`
	CostTotal    string  `json:"costTotal"`
}

func validateProduct(in productInput) (productInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		return in, errInvalid
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if len(in.Currency) != 3 {
		return in, errInvalid
	}
	for _, character := range in.Currency {
		if character < 'A' || character > 'Z' {
			return in, errInvalid
		}
	}
	if _, err := time.Parse("2006-01-02", in.EntryDate); err != nil {
		return in, errInvalid
	}
	if in.Status != "stock" && in.Status != "sold" {
		return in, errInvalid
	}
	if in.Status == "sold" {
		if in.SaleDate == nil {
			return in, errInvalid
		}
		if _, err := time.Parse("2006-01-02", *in.SaleDate); err != nil {
			return in, errInvalid
		}
	} else {
		in.SaleDate = nil
	}
	for _, amount := range []*string{in.SalePrice, in.MarketValue} {
		if amount == nil {
			continue
		}
		value, err := decimal.NewFromString(*amount)
		if err != nil || value.IsNegative() {
			return in, errInvalid
		}
		*amount = value.String()
	}
	for i := range in.Costs {
		in.Costs[i].Title = strings.TrimSpace(in.Costs[i].Title)
		value, err := decimal.NewFromString(in.Costs[i].Price)
		if in.Costs[i].Title == "" || err != nil || value.IsNegative() {
			return in, errInvalid
		}
		in.Costs[i].Price = value.String()
	}
	if in.ImageData != "" {
		if err := validateImage(in.ImageData); err != nil {
			return in, err
		}
	}
	return in, nil
}

func decodeJSON(data []byte, target any) error {
	if err := json.Unmarshal(data, target); err != nil {
		return errInvalid
	}
	return nil
}
