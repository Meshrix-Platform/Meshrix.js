package service

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestOfficeArchiveRejectsActualUnsafeStructureBeforeConversion(t *testing.T) {
	for _, entry := range []struct {
		name, content string
		mode          os.FileMode
	}{
		{"../outside.xml", "<x/>", 0},
		{"word/link", "target", os.ModeSymlink | 0777},
		{"word/document.xml", `<!DOCTYPE x SYSTEM "file:///unavailable"><x/>`, 0},
		{"word/_rels/document.xml.rels", `<Relationships><Relationship TargetMode="External" Type="image" Target="https://invalid.example/image"/></Relationships>`, 0},
		{"word/_rels/document.xml.rels", `<Relationships><Relationship Type="image" Target="file:///unavailable"/></Relationships>`, 0},
		{"word/document.xml", "<malformed", 0},
		{"word/_rels/document.xml.rels", `<Relationships><Relationship Target="/synthetic/outside.xml" Type="image"/></Relationships>`, 0},
	} {
		t.Run(entry.name+entry.content[:1], func(t *testing.T) {
			var buffer bytes.Buffer
			writer := zip.NewWriter(&buffer)
			part, _ := writer.Create("[Content_Types].xml")
			part.Write([]byte("<Types/>"))
			header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
			if entry.mode != 0 {
				header.SetMode(entry.mode)
			}
			part, _ = writer.CreateHeader(header)
			part.Write([]byte(entry.content))
			writer.Close()
			converter := &countingConverter{}
			response := httptest.NewRecorder()
			NewHTTPHandler(testConfig(t), converter, nil).ServeHTTP(response, multipartRequestWithTarget(t, "safe.docx", buffer.Bytes(), "pdf"))
			if response.Code != http.StatusUnsupportedMediaType || converter.calls.Load() != 0 {
				t.Fatal("unsafe archive reached converter")
			}
		})
	}
}

func TestOfficeArchivePreservesOrdinaryHyperlinksAndNestedPackages(t *testing.T) {
	nested := testDocxArchive(t, map[string]string{"word/document.xml": "<document/>"})
	data := testDocxArchive(t, map[string]string{
		"word/embeddings/document.docx": string(nested),
		"word/document.xml":             "<document/>",
		"_rels/.rels":                   `<Relationships><Relationship Target="/word/document.xml" Type="document"/></Relationships>`,
		"word/_rels/document.xml.rels":  `<Relationships><Relationship TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid"/></Relationships>`,
	})
	filename := filepath.Join(t.TempDir(), "document.docx")
	os.WriteFile(filename, data, 0600)
	if _, code := validateArchiveStructure(filename, 50<<20); code != "" {
		t.Fatal("ordinary package rejected", code)
	}
}

func TestOfficeArchiveRejectsDuplicateNamesAndChecksumMismatch(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		part, _ := writer.Create("[Content_Types].xml")
		part.Write([]byte("<Types/>"))
		header := &zip.FileHeader{Name: "word/document.xml", Method: zip.Store}
		part, _ = writer.CreateHeader(header)
		part.Write([]byte("<document/>"))
		if !corrupt {
			part, _ = writer.CreateHeader(&zip.FileHeader{Name: "word/document.xml", Method: zip.Store})
			part.Write([]byte("<document/>"))
		}
		writer.Close()
		data := buffer.Bytes()
		if corrupt {
			index := bytes.Index(data, []byte("<document/>"))
			data[index+1] = 'X'
		}
		filename := filepath.Join(t.TempDir(), "document.docx")
		os.WriteFile(filename, data, 0600)
		if _, code := validateArchiveStructure(filename, 50<<20); code == "" {
			t.Fatal("invalid archive accepted")
		}
	}
}
