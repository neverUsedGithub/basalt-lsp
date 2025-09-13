import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  Range,
  TextDocuments,
  TextDocumentSyncKind,
  type ExecuteCommandParams,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type TextDocumentPositionParams,
} from "vscode-languageserver/node";

import fs from "fs/promises";
import path from "path";
import util from "util";

import { TextDocument } from "vscode-languageserver-textdocument";
import { version as basaltVersion } from "../basalt/package.json";
import { version } from "../package.json";

import { compileProject } from "@basalt/basalt/compileProject";
import { CodeClientConnection } from "@basalt/codeclient";
import { Lexer } from "@basalt/lexer";
import { IF_CATEGORIES, Parser } from "@basalt/parser";
import type { ParserNode } from "@basalt/parser/nodes";
import { SourceError, SourceFile, type ErrorOptions } from "@basalt/shared/source";
import { Location } from "@basalt/shared/span";
import * as basaltStandard from "@basalt/standard";
import { TypeChecker } from "@basalt/typechecker";
import { builtins } from "@basalt/standard";
import {
  TypeCheckerAction,
  TypeCheckerCallable,
  TypeCheckerEvent,
  TypeCheckerGameValues,
  TypeCheckerNamespace,
  type TypeCheckerType,
} from "@basalt/typechecker/types";

let connection = createConnection(ProposedFeatures.all);

logMessage("Info", `Language server is starting...`);
logMessage("Info", `> lsp version ${version}`);
logMessage("Info", `> basalt version ${basaltVersion}`);

let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
  const result: InitializeResult = {
    capabilities: {
      hoverProvider: true,
      textDocumentSync: TextDocumentSyncKind.Incremental,

      completionProvider: {
        triggerCharacters: [":", " ", '"', "'", "="],
      },
    },
  };

  return result;
});

documents.onDidChangeContent((change) => validateTextDocument(change.document));

interface DocumentMeta {
  nodes: ParserNode[];
  checker: TypeChecker;
}

function getLogDate(): string {
  const now = new Date();
  const ampm = now.getHours() >= 12 ? "PM" : "AM";
  const hours = now.getHours() === 0 ? 12 : now.getHours() % 12;
  return `${`${hours}`.padStart(2, "0")}:${`${now.getMinutes()}`.padStart(2, "0")}:${`${now.getSeconds()}`.padStart(2, "0")} ${ampm}`;
}

function logMessage(level: "Warn" | "Info" | "Error", ...data: any[]) {
  connection.console.log(
    `[${level.padEnd(5, " ")} - ${getLogDate()}] ${data.map((v) => (typeof v === "string" ? v : util.inspect(v))).join(" ")}`,
  );
}

const BUILTINS_NAMES = Object.keys(builtins);
const documentToAST: Map<string, DocumentMeta> = new Map();

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const diagnostics: Diagnostic[] = [];

  const sourceFileName = path.basename(textDocument.uri);
  const sourceFile = new SourceFile(sourceFileName, textDocument.getText());

  let errors: ErrorOptions[] = [];
  let stage: string = "unknown";

  try {
    stage = "lexer";
    const lexer = new Lexer(sourceFile, "tolerant");
    const nodes: ParserNode[] = [];
    const parser = new Parser(sourceFile, lexer, "tolerant", (node) => nodes.push(node));

    stage = "parser";
    const programNode = parser.parse();
    errors.push(...lexer.getErrors(), ...parser.getErrors());

    stage = "typechecker";
    const checker = new TypeChecker(sourceFile, programNode, "tolerant");
    checker.checkProgram();
    errors.push(...checker.getErrors());

    documentToAST.set(textDocument.uri, { nodes, checker });
  } catch (error) {
    documentToAST.delete(textDocument.uri);
    logMessage("Warn", `Unrecoverable error. (stage ${stage})`);

    if (error instanceof SourceError) {
      errors.push(error.meta);
    }
  }

  for (const error of errors) {
    diagnostics.push({
      range: Range.create(error.span.start.line, error.span.start.col, error.span.end.line, error.span.end.col + 1),
      message: error.message,
    });
  }

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

const enum CompletionItemWeight {
  EVENT,
  ACTION,
  NAMESPACE,
  VARIABLE,
  FUNCTION,
  KEYWORD_ARGUMENT,
  LITERAL,
}

connection.onDidChangeWatchedFiles((_change) => {
  connection.console.log("We received a file change event");
});

function findNodeByPosition<T extends ParserNode["kind"][]>(
  location: Location,
  nodes: ParserNode[],
  types: T,
): (T[number] extends never ? ParserNode : Extract<ParserNode, { kind: T[number] }>) | null {
  for (let i = 0; i < nodes.length; i++) {
    if (types.length > 0 && types.includes(nodes[i]!.kind) && nodes[i]!.span.contains(location)) {
      // @ts-expect-error
      return nodes[i]!;
    }
  }

  return null;
}

interface RankedCompletionItem extends CompletionItem {
  weight?: number;
}

function makeCompletion(item: RankedCompletionItem): CompletionItem {
  item.sortText = (100 - (item.weight ?? 0)).toString().padStart(4, "0");
  return item;
}

function symbolToCompletion(
  name: string,
  type: TypeCheckerType,
  defaultKind: CompletionItemKind,
  scope?: string,
): CompletionItem {
  let kind: CompletionItemKind;
  let weight: CompletionItemWeight;
  let detail: string | undefined = undefined;

  const inserted =
    scope !== undefined ? (scope === "@line" || BUILTINS_NAMES.includes(name) ? name : `${scope} ${name}`) : undefined;

  if (type instanceof TypeCheckerAction) {
    kind = CompletionItemKind.Function;
    weight = CompletionItemWeight.ACTION;
    detail = type.opts.docs;
  } else if (type instanceof TypeCheckerEvent) {
    kind = CompletionItemKind.Event;
    weight = CompletionItemWeight.EVENT;
    detail = type.docs;
  } else if (type instanceof TypeCheckerCallable) {
    kind = CompletionItemKind.Function;
    weight = CompletionItemWeight.FUNCTION;
    detail = `fn ${type.asString()}`;
  } else if (type instanceof TypeCheckerNamespace) {
    kind = CompletionItemKind.Module;
    weight = CompletionItemWeight.NAMESPACE;
    detail = type.asString();
  } else {
    kind = defaultKind;
    weight = CompletionItemWeight.VARIABLE;
    detail = scope ? `let ${scope} ${name}: ${type.asString()}` : undefined;
  }

  return makeCompletion({
    label: name,
    kind: kind,
    insertText: inserted,
    weight,
    detail,
  });
}

function addVariableCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const currentNode = findNodeByPosition(location, nodes, ["Event", "FunctionDefinition"]);
  if (!currentNode) return;

  const scopeChild =
    currentNode.body && currentNode.body.body.length > 0
      ? currentNode.body.body[0]!
      : (currentNode.body ?? nodes[nodes.length - 1]!);

  const scope = checker.getScope(scopeChild)!;
  const scopeSymbols = scope.listSymbols();

  const addedVars = new Set<string>();

  for (const varScope in scopeSymbols) {
    for (const [name, symbol] of scopeSymbols[varScope as keyof typeof scopeSymbols]) {
      if (addedVars.has(name)) continue;

      addedVars.add(name);
      completions.push(symbolToCompletion(name, symbol.type, CompletionItemKind.Variable, symbol.scope));
    }
  }
}

function addNamespaceCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const node = findNodeByPosition(location, nodes, ["NamespaceGetProperty"]);
  if (!node) return;
  if (location.moreThan(node.property.span.end)) return;

  const nodeType = checker.getType(node.namespace) as TypeCheckerNamespace;
  if (!nodeType) return;

  completions.length = 0;

  for (const symbol of nodeType.listSymbols()) {
    const value = nodeType.getProperty(symbol)!;

    completions.push(symbolToCompletion(symbol, value, CompletionItemKind.Field));
  }
}

function addIfActionCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const node = findNodeByPosition(location, nodes, ["IfActionStatement"]);
  if (!node) return;

  if (node.category && IF_CATEGORIES.includes(node.category.value)) {
    const conditionTypes = basaltStandard.conditions[`if_${node.category.value}`]!;

    if (!node.action || (location.line === node.action.span.end.line && location.col <= node.action.span.end.col + 1)) {
      completions.length = 0;

      for (const [name] of conditionTypes.entries()) {
        completions.push({
          label: name,
          kind: CompletionItemKind.Function,
        });
      }
    }
  } else {
    completions.length = 0;

    for (const category of IF_CATEGORIES) {
      completions.push(
        makeCompletion({
          label: category,
          kind: CompletionItemKind.EnumMember,
        }),
      );
    }
  }
}

function addKeywordArgumentValueStringCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const keywArgument = findNodeByPosition(location, nodes, ["KeywordArgument"]);
  const callExpression = findNodeByPosition(location, nodes, ["CallExpression"]);
  if (!keywArgument || !callExpression) return;

  const callable = checker.getType(callExpression.expression)! as TypeCheckerCallable;
  const keywParam = callable.findKeywordParameter(keywArgument.name.value);
  const values: string[] = [];

  if (keywParam && keywParam.tag) {
    for (const value of keywParam.tag.values) {
      values.push(value.value.toString());
    }
  }

  for (const value of values) {
    completions.push(
      makeCompletion({
        label: value,
        kind: CompletionItemKind.Value,
      }),
    );
  }
}

function addKeywordArgumentValueCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const keywArgument = findNodeByPosition(location, nodes, ["KeywordArgument"]);
  const callExpression = findNodeByPosition(location, nodes, ["CallExpression"]);
  if (!keywArgument || !callExpression) return;

  const callable = checker.getType(callExpression.expression)! as TypeCheckerCallable;
  const keywParam = callable.findKeywordParameter(keywArgument.name.value);
  const values: string[] = [];

  if (keywParam && keywParam.tag) {
    for (const value of keywParam.tag.values) {
      values.push(value.asString());
    }
  }

  for (const value of values) {
    completions.push(
      makeCompletion({
        label: value,
        kind: CompletionItemKind.Value,
        weight: CompletionItemWeight.LITERAL,
      }),
    );
  }
}

function addKeywordArgumentCompletions(
  completions: CompletionItem[],
  location: Location,
  nodes: ParserNode[],
  checker: TypeChecker,
) {
  const keywArgument = findNodeByPosition(location, nodes, ["KeywordArgument"]);
  const callExpression = findNodeByPosition(location, nodes, ["CallExpression"]);

  if (!callExpression || keywArgument) return;

  const callable = checker.getType(callExpression.expression)! as TypeCheckerCallable;
  const keywParams = callable.getAllKeywordArguments();

  for (const param of keywParams) {
    completions.push(
      makeCompletion({
        label: param.name,
        kind: CompletionItemKind.Field,
        weight: CompletionItemWeight.KEYWORD_ARGUMENT,
      }),
    );
  }
}

connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
  const documentMeta = documentToAST.get(textDocumentPosition.textDocument.uri);
  if (!documentMeta) return [];

  const { nodes, checker } = documentMeta;
  const location = new Location(textDocumentPosition.position.line, textDocumentPosition.position.character);

  const completions: CompletionItem[] = [];
  const stringNode = findNodeByPosition(location, nodes, ["String", "StyledText"]);

  if (!stringNode) {
    addVariableCompletions(completions, location, nodes, checker);
    addNamespaceCompletions(completions, location, nodes, checker);
    addIfActionCompletions(completions, location, nodes, checker);
    addKeywordArgumentCompletions(completions, location, nodes, checker);
    addKeywordArgumentValueCompletions(completions, location, nodes, checker);
  } else {
    addKeywordArgumentValueStringCompletions(completions, location, nodes, checker);
  }

  return completions;
});

function hoverCompletionCode(code: string): string {
  return `\`\`\`basalt\n${code}\n\`\`\``;
}

function hoverCompletionText(text: string) {
  return text;
}

function hoverCompletionTextCode(text: string, code: string): string {
  return `${hoverCompletionText(text)}\n${hoverCompletionCode(code)}`;
}

connection.onHover(async (hover: HoverParams) => {
  const documentMeta = documentToAST.get(hover.textDocument.uri);
  if (!documentMeta) return null;

  const { nodes, checker } = documentMeta;
  const location = new Location(hover.position.line, hover.position.character);

  const hoveredNode = findNodeByPosition(location, nodes, ["VariableNode", "Identifier", "Builtin"]);
  if (!hoveredNode) return null;

  const scope =
    hoveredNode.kind === "VariableNode" ? (hoveredNode.scope !== "@line" ? `${hoveredNode.scope} ` : "") : "";

  const type = checker.getType(hoveredNode);
  let message: string;

  if (type !== null) {
    message = hoverCompletionCode(`let ${scope}${hoveredNode.name.value}${type ? `: ${type.asString()}` : ""};`);
  } else if (hoveredNode.kind === "Identifier") {
    const namespaceGet = findNodeByPosition(location, nodes, ["NamespaceGetProperty"]);
    if (!namespaceGet || namespaceGet.property !== hoveredNode) return null;

    const namespaceType = checker.getType(namespaceGet.namespace)!;
    const valueType = checker.getType(namespaceGet)!;

    if (namespaceType instanceof TypeCheckerGameValues) {
      const gameValue = namespaceType.getGameValue(hoveredNode.name.value);
      if (!gameValue) return null;

      message = hoverCompletionTextCode(gameValue.docs, gameValue.type.asString());
    } else if (valueType instanceof TypeCheckerEvent) {
      message = hoverCompletionText(valueType.docs);
    } else if (valueType instanceof TypeCheckerAction) {
      message = hoverCompletionTextCode(valueType.opts.docs, `fn ${valueType.asString()}`);
    } else if (valueType instanceof TypeCheckerCallable) {
      message = hoverCompletionCode(`fn ${valueType.asString()}`);
    } else {
      message = valueType.asString();
    }
  } else {
    return null;
  }

  return {
    contents: {
      kind: "markdown",
      value: message,
    },
    range: {
      start: { line: hoveredNode.span.start.line, character: hoveredNode.span.start.col },
      end: { line: hoveredNode.span.end.line, character: hoveredNode.span.end.col + 1 },
    },
  };
});

function fileExists(pth: string): Promise<boolean> {
  return fs.access(pth, fs.constants.R_OK).then(
    () => true,
    () => false,
  );
}

function sleepMS(time: number): Promise<void> {
  return new Promise((res) => setTimeout(res, time));
}

async function runProjectFromFile(filename: string) {
  let current = path.dirname(filename);

  while (true) {
    if (current === "/") return connection.window.showErrorMessage("Couldn't locate basalt.toml file.");
    if (await fileExists(path.join(current, "basalt.toml"))) break;
    current = path.dirname(current);
  }

  logMessage("Info", `Running project at '${current}'`);

  const compileStart = performance.now();
  let result;

  try {
    result = await compileProject(current);
  } catch (e) {
    console.error(e);
    connection.window.showErrorMessage(`Compilation failed: ${e}`);
    return;
  }

  if (!result.isOk()) {
    connection.window.showErrorMessage(`Compilation failed: ${result.unwrapErr()}`);
    return;
  }

  const rows = result.unwrap();
  const compileTime = performance.now() - compileStart;

  const codeClient = new CodeClientConnection(["movement", "write_code"]);
  await codeClient.authed();

  connection.window.showInformationMessage(`Compilation succeeded in ${compileTime.toFixed(2)}ms`);

  try {
    codeClient.setMode("dev");
    await sleepMS(600);
    await codeClient.placeTemplates(rows);
    await sleepMS(600);
    codeClient.setMode("play");
    await sleepMS(600);
    await codeClient.close();
    connection.window.showInformationMessage(`Placing codeblocks done.`);
  } catch {
    connection.window.showErrorMessage(`Placing codeblocks failed.`);
  }
}

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command === "basalt.runfile") {
    const filePath = params.arguments?.[0] as string;
    await runProjectFromFile(filePath);
  }
});

documents.listen(connection);
connection.listen();
