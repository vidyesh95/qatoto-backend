import { describe, expect, it } from "vitest";

import {
  isTeardownFileValidationError,
  MAX_TEARDOWN_FABRICATION_FILE_BYTES,
  validateTeardownFileBytes,
} from "#src/modules/home/blueprints/teardown-file-bytes.js";

/**
 * ⚠️ THE CASE THAT MATTERS MOST IS THE RENAMED HTML PAGE, not the malformed CAD file. An author
 * saving a `.dxf` as `.step` is an accident this module turns into a readable 422; an HTML document
 * stored under a CAD label is the shape that becomes a stored-XSS vector the moment any surface
 * decides to render a file inline. Every format is asserted against it.
 */
const HTML_PAGE = Buffer.from(
  `<!doctype html><html><head><title>not a model</title></head><body>${"x".repeat(900)}</body></html>`,
  "latin1",
);

/**
 * Padded past 512 bytes deliberately. `validatePdfBytes` carries its own `MIN_PAPER_BYTES` floor,
 * so a fixture under it is refused as `TOO_SMALL` before any header is read — which is a perfectly
 * good refusal but the wrong one to assert when the point is that the FORMAT does not match.
 */
function buildStepFile(): Buffer {
  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_NAME('a','',(''),(''),'','','');",
    "ENDSEC;",
    "DATA;",
    ...Array.from({ length: 40 }, (_unused, index) => `#${String(index + 1)}=PRODUCT('a','a','',());`),
    "ENDSEC;",
    "END-ISO-10303-21;",
  ];
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

function buildAsciiStl(): Buffer {
  const facet = [
    "facet normal 0 0 1",
    "outer loop",
    "vertex 0 0 0",
    "vertex 1 0 0",
    "vertex 0 1 0",
    "endloop",
    "endfacet",
  ].join("\n");
  return Buffer.from(["solid part", facet, facet, "endsolid part"].join("\n") + "\n", "latin1");
}

/** 84 + 50 × triangleCount, exactly. The invariant IS the check. */
function buildBinaryStl(declaredTriangles: number, actualTriangles = declaredTriangles): Buffer {
  const bytes = Buffer.alloc(84 + 50 * actualTriangles);
  bytes.write("binary stl fixture", 0, "latin1");
  bytes.writeUInt32LE(declaredTriangles, 80);
  return bytes;
}

function buildDxf(): Buffer {
  const lines = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1015",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    "0",
    "ENDSEC",
    "0",
    "EOF",
  ];
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

function buildPdf(): Buffer {
  const lines = [
    "%PDF-1.7",
    "1 0 obj",
    "<< /Type /Catalog >>",
    "endobj",
    ...Array.from({ length: 80 }, () => "% padding"),
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ];
  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

describe("teardown upload byte validation", () => {
  describe("the empty and oversized cases, which every format shares", () => {
    it("refuses an empty buffer, so a zero-byte row never reaches either table", () => {
      const outcome = validateTeardownFileBytes("step", Buffer.alloc(0));

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("EMPTY");
    });

    /**
     * ⚠️ THE ZERO-BYTE REFUSAL IS LOAD-BEARING, not tidiness. `teardown_document.byte_size` is
     * `>= 0` and `teardown_manufacturing_file.byte_size` is `> 0` — a deliberate asymmetry the
     * schema comments defend. A zero-byte upload would satisfy one table and be refused by the
     * other, as a 23514 nobody can read. Refusing it here means the asymmetry is never exercised.
     */
    it("refuses a file too small to carry a header of any kind", () => {
      const outcome = validateTeardownFileBytes("stl", Buffer.from("solid", "latin1"));

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("TOO_SMALL");
    });

    it("refuses a CAD file over the fabrication ceiling", () => {
      const oversized = Buffer.alloc(MAX_TEARDOWN_FABRICATION_FILE_BYTES + 1);
      oversized.write("ISO-10303-21;", 0, "latin1");

      const outcome = validateTeardownFileBytes("step", oversized);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("TOO_LARGE");
    });
  });

  describe("STEP — the two markers ISO 10303-21 mandates", () => {
    it("accepts a well-framed part-21 file", () => {
      const outcome = validateTeardownFileBytes("step", buildStepFile());

      expect(isTeardownFileValidationError(outcome)).toBe(false);
      expect(!isTeardownFileValidationError(outcome) && outcome.format).toBe("step");
    });

    it("refuses one missing its closing marker — the truncated transfer", () => {
      const framed = buildStepFile().toString("latin1");
      const truncated = Buffer.from(framed.replace("END-ISO-10303-21;", ""), "latin1");

      const outcome = validateTeardownFileBytes("step", truncated);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });

    it("refuses an HTML page renamed .step", () => {
      const outcome = validateTeardownFileBytes("step", HTML_PAGE);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });
  });

  describe("STL — an arithmetic invariant a wrong file cannot satisfy by accident", () => {
    it("accepts a binary STL whose length matches its declared triangle count", () => {
      const outcome = validateTeardownFileBytes("stl", buildBinaryStl(12));

      expect(isTeardownFileValidationError(outcome)).toBe(false);
    });

    /** ⚠️ THE STRONGEST ASSERTION IN THIS FILE: one triangle short and the arithmetic fails. */
    it("refuses a binary STL that declares more triangles than it carries", () => {
      const outcome = validateTeardownFileBytes("stl", buildBinaryStl(12, 11));

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });

    it("accepts an ASCII STL", () => {
      const outcome = validateTeardownFileBytes("stl", buildAsciiStl());

      expect(isTeardownFileValidationError(outcome)).toBe(false);
    });

    it("refuses an HTML page renamed .stl", () => {
      const outcome = validateTeardownFileBytes("stl", HTML_PAGE);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });
  });

  describe("DXF — ASCII only, and binary is refused on purpose", () => {
    it("accepts an ASCII DXF", () => {
      const outcome = validateTeardownFileBytes("dxf", buildDxf());

      expect(isTeardownFileValidationError(outcome)).toBe(false);
    });

    it("refuses a binary DXF, whose sentinel is easy to detect and deliberately unsupported", () => {
      const binaryDxf = Buffer.concat([Buffer.from("AutoCAD Binary DXF", "latin1"), Buffer.alloc(200)]);

      const outcome = validateTeardownFileBytes("dxf", binaryDxf);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });

    it("refuses an HTML page renamed .dxf", () => {
      const outcome = validateTeardownFileBytes("dxf", HTML_PAGE);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });
  });

  describe("PDF — delegated, never re-implemented", () => {
    it("accepts a PDF that validatePdfBytes accepts", () => {
      const outcome = validateTeardownFileBytes("pdf", buildPdf());

      expect(isTeardownFileValidationError(outcome)).toBe(false);
      expect(!isTeardownFileValidationError(outcome) && outcome.format).toBe("pdf");
    });

    it("refuses an HTML page renamed .pdf", () => {
      const outcome = validateTeardownFileBytes("pdf", HTML_PAGE);

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });

    /**
     * ⚠️ A STEP FILE DECLARED AS A PDF IS REFUSED, which is the case the DECLARED format exists
     * for. The multipart mimetype gate cannot catch it — a browser sends `application/octet-stream`
     * for both — so without the declaration these bytes would be stored under whichever label the
     * client preferred.
     */
    it("refuses a well-framed STEP file declared as a PDF", () => {
      const outcome = validateTeardownFileBytes("pdf", buildStepFile());

      expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
    });
  });

  /** The mirror of the case above: the declaration is checked in both directions. */
  it("refuses a PDF declared as a STEP file", () => {
    const outcome = validateTeardownFileBytes("step", buildPdf());

    expect(isTeardownFileValidationError(outcome) && outcome.type).toBe("FORMAT_MISMATCH");
  });
});
