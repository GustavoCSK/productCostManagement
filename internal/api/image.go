package api

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"

	_ "golang.org/x/image/webp"
)

const maximumImageBytes = 5 << 20

func validateImage(value string) error {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
		return errInvalid
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > maximumImageBytes {
		return errInvalid
	}
	_, kind, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (kind != "jpeg" && kind != "png" && kind != "webp") {
		return errInvalid
	}
	expected := map[string]string{
		"data:image/jpeg;base64": "jpeg",
		"data:image/png;base64":  "png",
		"data:image/webp;base64": "webp",
	}[header]
	if expected == "" || expected != kind {
		return errInvalid
	}
	return nil
}
