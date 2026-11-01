export type ImportKind =
  | "es"
  | "dynamic"
  | "require"
  | "type";

export interface ParsedImport {
  source: string;
  kind: ImportKind;
  line: number;
  column: number;
}

export interface ParsedExport {
  name: string;
  kind: "named" | "default" | "all";
  line: number;
}

export interface ParsedDeclaration {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "variable"
    | "enum";
  line: number;
  endLine: number;
}

export interface ParseDiagnostic {
  message: string;
  line: number;
  column: number;
  code: number;
}

export interface ParsedSourceFile {
  filePath: string;
  imports: ParsedImport[];
  exports: ParsedExport[];
  declarations: ParsedDeclaration[];
  diagnostics: ParseDiagnostic[];
  lineCount: number;
  isValid: boolean;
}