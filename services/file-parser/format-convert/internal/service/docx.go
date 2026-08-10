package service

import (
	"archive/zip"
	"bufio"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

const (
	maxTextLineBytes      = 1 << 20
	maxTextParagraphBytes = 4 << 20
)

var (
	ErrTextEncodingInvalid  = errors.New("text input is not valid UTF-8")
	ErrTextControlInvalid   = errors.New("text input contains unsupported control characters")
	ErrTextLineTooLong      = errors.New("text input contains an oversized line")
	ErrTextParagraphTooLong = errors.New("text input contains an oversized paragraph")
	ErrTextEmpty            = errors.New("text input has no content")
)

const contentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const packageRelationshipsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const documentRelationshipsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:cs="Liberation Serif"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:ind w:firstLine="420"/><w:jc w:val="both"/></w:pPr></w:style>
</w:styles>`

func CreateDOCXFromText(inputPath, outputPath string) (err error) {
	input, err := os.Open(inputPath)
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	succeeded := false
	defer func() {
		if closeErr := output.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
		if !succeeded {
			_ = os.Remove(outputPath)
		}
	}()

	archive := zip.NewWriter(output)
	if err = writeDOCXEntry(archive, "[Content_Types].xml", contentTypesXML); err != nil {
		_ = archive.Close()
		return err
	}
	if err = writeDOCXEntry(archive, "_rels/.rels", packageRelationshipsXML); err != nil {
		_ = archive.Close()
		return err
	}
	if err = writeDOCXEntry(archive, "word/_rels/document.xml.rels", documentRelationshipsXML); err != nil {
		_ = archive.Close()
		return err
	}
	if err = writeDOCXEntry(archive, "word/styles.xml", stylesXML); err != nil {
		_ = archive.Close()
		return err
	}
	document, err := archive.CreateHeader(&zip.FileHeader{Name: "word/document.xml", Method: zip.Deflate})
	if err != nil {
		_ = archive.Close()
		return err
	}
	if err = writeTextDocumentXML(document, input); err != nil {
		_ = archive.Close()
		return err
	}
	if err = archive.Close(); err != nil {
		return err
	}
	succeeded = true
	return nil
}

func writeDOCXEntry(archive *zip.Writer, name, content string) error {
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
	if err != nil {
		return err
	}
	_, err = io.WriteString(entry, content)
	return err
}

func writeTextDocumentXML(output io.Writer, input io.Reader) error {
	if _, err := io.WriteString(output, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`); err != nil {
		return err
	}

	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), maxTextLineBytes)
	var paragraph strings.Builder
	paragraphCount := 0
	lineNumber := 0
	flush := func() error {
		text := strings.TrimSpace(paragraph.String())
		paragraph.Reset()
		if text == "" {
			return nil
		}
		paragraphCount++
		return writeDOCXParagraph(output, text)
	}

	for scanner.Scan() {
		lineNumber++
		line := scanner.Text()
		if lineNumber == 1 {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		if !utf8.ValidString(line) {
			return ErrTextEncodingInvalid
		}
		line = strings.ReplaceAll(line, "\t", "    ")
		for _, value := range line {
			if value < 0x20 || value == 0x7f {
				return ErrTextControlInvalid
			}
		}
		line = strings.TrimSpace(line)
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		additionalBytes := len(line)
		if paragraph.Len() > 0 {
			additionalBytes++
		}
		if paragraph.Len()+additionalBytes > maxTextParagraphBytes {
			return ErrTextParagraphTooLong
		}
		if paragraph.Len() > 0 {
			paragraph.WriteByte(' ')
		}
		paragraph.WriteString(line)
	}
	if err := scanner.Err(); err != nil {
		if strings.Contains(err.Error(), "token too long") {
			return ErrTextLineTooLong
		}
		return err
	}
	if err := flush(); err != nil {
		return err
	}
	if paragraphCount == 0 {
		return ErrTextEmpty
	}
	_, err := io.WriteString(output, `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`)
	return err
}

func writeDOCXParagraph(output io.Writer, text string) error {
	if _, err := io.WriteString(output, `<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t xml:space="preserve">`); err != nil {
		return err
	}
	if err := xml.EscapeText(output, []byte(text)); err != nil {
		return err
	}
	_, err := io.WriteString(output, `</w:t></w:r></w:p>`)
	return err
}
