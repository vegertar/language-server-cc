// @ts-check

import { open } from "node:fs/promises";
import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  ProposedFeatures,
  SymbolKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query, { SEMANTIC_EXPANSION, SEMANTIC_INACTIVE } from "./query.js";
import * as mark from "./mark.js";

const query = new Query();

/**
 *
 * @param {string} uri
 */
async function getUriInfo(uri) {
  const { document: doc, pathname } = await getDocument(uri);
  const src = await query.src(pathname);
  return { doc, src };
}

const specMarks = {
  1: new mark.Emphasis("extern"),
  2: new mark.Emphasis("static"),
  4: new mark.Emphasis("inline"),
  8: new mark.Emphasis("const"),
  16: new mark.Emphasis("volatile"),
};

const specs = {
  hasLeadingSpace: 32,
};

const symbolKinds = Object.assign(
  SymbolKind,
  /** @type {const} */ ({
    Union: 100,
    TypeAlias: 101,
  })
);

/**
 * Semantic Tokens
 */
const tokenTypes = ["macro", "comment"];
const tokenModifiers = [];

const tokenTypesMap = Object.fromEntries(tokenTypes.map((v, i) => [v, i]));

/**
 *
 * @param {import("./query.js").Semantics} semantics
 */
function tokenSemantics(semantics) {
  switch (semantics) {
    case SEMANTIC_EXPANSION:
      return [tokenTypesMap["macro"], 0];
    case SEMANTIC_INACTIVE:
      return [tokenTypesMap["comment"], 0];
  }
}

/**
 *
 * @param {number} specs
 * @param {mark.Mark[]} [marks]
 * @returns
 */
function markSpecs(specs, marks = []) {
  for (const spec in specMarks) {
    if (specs & parseInt(spec)) {
      marks.push(specMarks[spec], mark.space);
    }
  }
  return marks;
}

/**
 *
 * @param {string} uri
 * @returns
 */
async function getDocument(uri) {
  const pathname = new URL(uri).pathname;
  let document = documents.get(uri);
  if (!document) {
    const file = await open(pathname);
    const content = await file.readFile({ encoding: "utf8" });
    await file.close();
    document = TextDocument.create(uri, "", 0, content);
    documents.set(uri, document);
  }
  return { document, pathname };
}

/**
 *
 * @param {number} ch
 */
function isPartOfIdentifier(ch) {
  return (
    (48 <= ch && ch <= 57) /* [0-9] */ ||
    (65 <= ch && ch <= 90) /* [A-Z] */ ||
    ch == 95 /* _ */ ||
    (97 <= ch && ch <= 122) /* [a-z] */
  );
}

/**
 *
 * @param {TextDocument} doc
 * @param {import("vscode-languageserver-textdocument").Position} start
 * @returns {import("vscode-languageserver-textdocument").Position}
 */
function getTokenHead(doc, start) {
  let offset = doc.offsetAt(start);
  let end = doc.positionAt(offset + 1);

  if (!isPartOfIdentifier(doc.getText({ start, end }).charCodeAt(0)))
    return start;

  do {
    end = start;
    start = doc.positionAt(--offset);
    if (!isPartOfIdentifier(doc.getText({ start, end }).charCodeAt(0))) break;
  } while (offset >= 0);

  return end;
}

/**
 * @typedef {{
 *   doc: import("vscode-languageserver-textdocument").TextDocument,
 *   src: number,
 *   pos: import("vscode-languageserver/node.js").Position,
 *   loc: import("vscode-languageserver/node.js").Position | null,
 *   token: import("./query.js").Token,
 *   node?: import("./query.js").Node,
 *   link?: import("./query.js").Node[],
 *   mark?: mark.Mark,
 * }} Value
 */

/**
 *
 * @param {import("vscode-languageserver/node.js").TextDocumentPositionParams} param0
 * @returns {Promise<Value>}
 */
async function positionHandler({ textDocument: { uri }, position }) {
  const info = await getUriInfo(uri);
  const pos = getTokenHead(info.doc, position);
  const loc = await query.loc(info.src, pos);
  const token = await query.token(info.src, loc || pos);
  return { ...info, pos, loc, token };
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function tokenHandler(value) {
  if (value.token) {
    value.node = await query.node(value.token.decl);
  } else {
    // Sometimes Clang does not generate tokens, e.g., in macro expansions within conditional preprocessors.
    // In such cases, we query the AST node by position.
    value.node = await query.decl(value.src, value.pos);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function hoverHandler(value) {
  const { node } = value;

  if (node) {
    const marks = markSpecs(node.specs);

    switch (node.kind) {
      case "TypedefDecl":
        marks.push(new mark.Emphasis("typedef"), mark.space);
        break;
      case "FieldDecl":
        marks.push(new mark.Emphasis("field"), mark.space);
        break;
      case "RecordDecl":
        switch (node.class) {
          case 1:
            marks.push(new mark.Emphasis("struct"), mark.space);
            break;
        }
        break;
      case "MacroDecl":
        marks.push(
          new mark.Emphasis("#define"),
          mark.space,
          new mark.Strong(
            (await query.node(node.parent_number))?.name || "Never"
          )
        );
        node.sqname && marks.push(new mark.Strong(node.sqname));
        break;
      case "ExpansionDecl":
        if (node.ref_ptr) {
          const v = await hoverHandler({
            ...value,
            node: await query.node(node.ref_ptr),
          });
          if (v.mark) {
            marks.push(v.mark, mark.newLine, mark.thematicBreak, mark.newLine);
            const nodes = await query.range(node.number, node.final_number);
            /** @type {Map<number, number>} */
            const indents = new Map();
            indents.set(nodes[0].number, 0);
            for (let i = 1, n = nodes.length; i < n; ++i) {
              const parentIndent = indents.get(nodes[i].parent_number);
              indents.set(
                nodes[i].number,
                parentIndent == undefined ? 0 : parentIndent + 2
              );
            }

            for (let i = 0, n = nodes.length; i < n; ) {
              marks.push(
                new mark.Indent(indents.get(nodes[i].number) || 0),
                new mark.BulletListItem(nodes[i].name || "Never"),
                mark.newLine
              );

              while (++i < n && nodes[i].kind === "Token") {
                const indent = indents.get(nodes[i].number) || 0;
                const codes = [nodes[i].name || "Never"];
                while (
                  ++i < n &&
                  nodes[i].kind === "Token" &&
                  indents.get(nodes[i].number) == indent
                ) {
                  const node = nodes[i];
                  if (node.specs & specs.hasLeadingSpace) codes.push(" ");
                  codes.push(node.name || "Never");
                }

                marks.push(new mark.CodeBlock(codes, indent, "c"));
                --i;
              }
            }
          }
        }
        break;
    }

    if (node.kind !== "ExpansionDecl") {
      node.name && marks.push(new mark.Strong(node.name));

      if (node.class) {
        const children = await query.children(node.number);
        if (children.length) marks.push(mark.newLine, mark.thematicBreak);
        for (const node of children) {
          const v = await hoverHandler({ ...value, node });
          if (v.mark) marks.push(mark.lineEnding, mark.lineEnding, v.mark);
        }
      } else {
        const { qualified_type, desugared_type } = node;
        if (qualified_type)
          marks.push(mark.colon, mark.space, new mark.Emphasis(qualified_type));
        if (desugared_type && desugared_type !== qualified_type)
          marks.push(mark.space, new mark.Code(desugared_type));
      }

      if (node.begin_src != -1) {
        const filename = await query.filename(node.begin_src);
        if (filename)
          marks.push(
            mark.newLine,
            mark.thematicBreak,
            mark.newLine,
            new mark.CodeInline(filename),
            new mark.Emphasis("provided")
          );
      }
    }

    value.mark = new mark.Mark(marks);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function declarationHandler(value) {
  if (value.link) {
    const definition = value.link[0];
    /** @type {import("./query.js").Node | undefined} */
    let decl = definition;
    while (decl?.prev) {
      decl = await query.node(decl.prev);
      if (decl) value.link.push(decl);
    }
  }

  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function definitionHandler(value) {
  const { node } = value;

  if (node) {
    value.link = [];
    let decl = node.ref_ptr ? await query.node(node.ref_ptr) : node;
    switch (decl?.kind) {
      case "FunctionDecl":
        /**
         * Try to find the definition as much as possible.
         *
         * C/C++ allows multiple declarations and only one definition, e.g.
         *   void foo();   // decl 1
         *   void foo();   // decl 2
         *   ...
         *   void foo();   // decl N
         *   void foo() {} // definition
         *
         * Ordinarily, when we refer to the definition of a function, we mean the
         * specific function definition with a body, so we should always reach
         * the line "void foo() {}".
         *
         * However, in some cases, the definition is optional, e.g., sizeof(&foo);.
         * In this case, we should point to the last declaration rather than
         * leaving a null result or retaining the initial declaration we started with.
         * This allows us to chain all declarations in the next handler.
         */

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const next = await query.next(decl.ptr);
          if (!next) break;
          decl = next;
        }
        break;
    }

    if (decl) value.link.push(decl);
  }

  return value;
}

/**
 * @param {import("vscode-languageserver/node.js").ReferenceContext} context
 */
function referencesHandler(context) {
  /**
   *
   * @param {Value} value
   * @returns {Promise<Value>}
   */
  return async (value) => {
    if (value.link) {
      const refs = await query.refs(value.link.map((node) => node.ptr));
      if (context.includeDeclaration) value.link.push(...refs);
      else value.link = refs;
    }

    return value;
  };
}

/**
 *
 * @param {import("./query.js").Node} node
 * @param {import("vscode-languageserver-textdocument").TextDocument} doc
 * @returns
 */
function getRanges(node, doc) {
  const namePosition =
    node.row > 0
      ? {
          line: node.row - 1,
          character: node.col - 1,
        }
      : {
          line: node.begin_row - 1,
          character: node.begin_col - 1,
        };

  const nameEndOffset =
    doc.offsetAt(namePosition) + (node.name ? node.name.length : 1);

  const range = {
    start: {
      line: node.begin_row - 1,
      character: node.begin_col - 1,
    },
    end: doc.positionAt(
      Math.max(
        doc.offsetAt({
          line: node.end_row - 1,
          character: node.end_col - 1,
        }) + 1,
        nameEndOffset
      )
    ),
  };

  const selectionRange = {
    start: namePosition,
    end: doc.positionAt(nameEndOffset),
  };

  return { range, selectionRange };
}

/**
 *
 * @param {Value} value
 * @returns {Promise<import("vscode-languageserver/node.js").LocationLink[] | null>}
 */
async function linkHandler(value) {
  if (value.link) {
    /** @type {import("vscode-languageserver/node.js").LocationLink[]} */
    const links = [];

    for (const node of value.link) {
      const filename = await query.filename(node.begin_src);
      // Skip the builtin files
      if (!filename || filename.startsWith("<")) continue;

      const uri = "file://" + filename;
      const { document: doc } = await getDocument(uri);

      const result = getRanges(node, doc);
      links.push({
        targetUri: uri,
        targetRange: result.range,
        targetSelectionRange: result.selectionRange,
      });
    }
    return links;
  }
  return null;
}

/**
 *
 * @param {import("vscode-languageserver/node.js").LocationLink[] | null} links
 * @returns {import("vscode-languageserver/node.js").Location[] | null}
 */
function locationHandler(links) {
  return links
    ? links.map((link) => ({
        uri: link.targetUri,
        range: link.targetSelectionRange,
      }))
    : null;
}

/**
 *
 * @param {Value} value
 * @returns {import("vscode-languageserver/node.js").Hover | null}
 */
function markHandler(value) {
  if (value.mark) {
    return {
      contents: {
        kind: "markdown",
        value: value.mark.toText(),
      },
    };
  }
  return null;
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

/**
 * Create a simple text document manager.
 * @type {Map<import("vscode-languageserver/node.js").URI, import("vscode-languageserver-textdocument").TextDocument>}
 **/
const documents = new Map();

/**
 *
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
export function readDir(dirPath) {
  return new Promise((resolve) => {
    fs.readdir(dirPath, (error, list) => {
      if (error) {
        resolve([]);
      } else {
        resolve(list);
      }
    });
  });
}

/**
 *
 * @param {string} filePath
 * @returns {Promise<fs.Stats | undefined>}
 */
function getLStat(filePath) {
  return new Promise((resolve) => {
    fs.lstat(filePath, (_err, stats) => {
      if (stats) {
        resolve(stats);
      } else {
        resolve(undefined);
      }
    });
  });
}

/**
 *
 * @param {string} dir
 * @param {RegExp} regex
 * @param {string[]} files
 * @param {string[]} result
 * @returns
 */
async function recGetAllFilePaths(dir, regex, files, result) {
  for (const item of files) {
    const file = path.join(dir, item);
    try {
      const status = await getLStat(file);
      if (status) {
        if (status.isDirectory() && !status.isSymbolicLink()) {
          result = await recGetAllFilePaths(
            file,
            regex,
            await readDir(file),
            result
          );
        } else if (status.isFile() && regex.test(file)) {
          result.push(file);
        }
      }
    } catch (error) {
      continue;
    }
  }
  return result;
}

connection.onInitialize(async ({ workspaceFolders, initializationOptions }) => {
  /** @type {string[] | undefined} */
  let translationUnits;

  const uri = workspaceFolders?.[0].uri;
  if (uri) {
    const path = new URL(uri).pathname;
    translationUnits = await recGetAllFilePaths(
      path,
      /\.o$/,
      await readDir(path),
      []
    );
  }

  /** @type {string | undefined} */
  const translationUnit = initializationOptions?.translationUnit;
  if (translationUnit) query.tu = translationUnit;

  return {
    capabilities: {
      hoverProvider: true,
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      documentLinkProvider: { resolveProvider: true },
      semanticTokensProvider: {
        legend: { tokenTypes, tokenModifiers },
        range: true,
        full: { delta: true },
      },
      experimental: { translationUnits },
    },
  };
});

connection.onInitialized(async () => {});

connection.onDidChangeConfiguration(async ({ settings }) => {
  if (Array.isArray(settings)) {
    for (let i = 0, n = settings.length; i < n; i += 2)
      switch (settings[i]) {
        case "languageServerCC.tu":
          query.tu = settings[i + 1];
          break;
      }
  }
});

connection.onDocumentLinks(async ({ textDocument }) => {
  const { src } = await getUriInfo(textDocument.uri);
  const nodes = await query.links(src);
  /** @type {import("vscode-languageserver/node.js").DocumentLink[]} */
  const links = [];

  for (const node of nodes) {
    if (!node.desugared_type) continue;
    links.push({
      range: {
        start: {
          line: node.row - 1,
          character: node.col - 1,
        },
        end: {
          line: node.row,
          character: 0,
        },
      },
      target: "file://" + node.desugared_type,
      tooltip: `_#${node.name}_ **"${node.desugared_type}"**`,
    });
  }

  return links;
});

connection.onDocumentSymbol(async ({ textDocument }) => {
  const { doc, src } = await getUriInfo(textDocument.uri);
  const nodes = await query.symbols(src);
  /** @type {import("vscode-languageserver/node.js").DocumentSymbol[]} */
  const symbols = [];

  for (const node of nodes) {
    if (!node.name) continue;

    let kind = 0;
    switch (node.kind) {
      case "FunctionDecl":
        kind = symbolKinds.Function;
        break;

      case "RecordDecl":
        if (node.class === 1) kind = symbolKinds.Struct;
        else if (node.class === 2) kind = symbolKinds.Union;
        else if (node.class === 3) kind = symbolKinds.Enum;
        break;

      case "VarDecl":
        kind = symbolKinds.Variable;
        break;

      case "TypedefDecl":
        kind = symbolKinds.TypeAlias;
        break;
    }

    if (!kind || node.row == 0) continue;

    const ranges = getRanges(node, doc);
    symbols.push({
      name: node.name,
      kind: /** @type {any} */ (kind),
      ...ranges,
    });
  }

  return symbols;
});

connection.onDefinition(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    linkHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onDeclaration(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    linkHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onReferences(async ({ context, ...param }) => {
  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    referencesHandler(context),
    linkHandler,
    locationHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onHover(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    hoverHandler,
    markHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

/**
 * @param {import("vscode-languageserver/node.js").SemanticTokensParams & {range?: import("vscode-languageserver/node.js").Range}} param0
 * @returns {Promise<import("vscode-languageserver/node.js").SemanticTokens | null>}
 */
async function onTextDocumentSemanticTokens({ textDocument, range }) {
  const { doc, src } = await getUriInfo(textDocument.uri);
  const semanticRanges = await query.semantics(src, range);

  /**
   * @typedef {{
   *   line: number,
   *   character: number,
   *   length: number,
   *   tokenType: number,
   *   tokenModifier: number,
   * }} SemanticTokenItem
   */

  /** @typedef {SemanticTokenItem[]} */
  const items = [];

  for (const value of semanticRanges) {
    let { begin_row, begin_col, end_row, end_col, semantics } = value;
    const [tokenType, tokenModifier] = tokenSemantics(semantics);
    let offset = 0;

    do {
      /** @type {SemanticTokenItem} */
      const item = {
        tokenType,
        tokenModifier,
        line: begin_row - 1,
        character: begin_col - 1,
        length: 0,
      };

      items.push(item);

      if (begin_row == end_row) {
        item.length = end_col - begin_col;
      } else {
        // There are multiple lines
        const nextLine = { line: begin_row, character: 0 };
        const nextOffset = doc.offsetAt(nextLine);
        item.length = nextOffset - (offset || doc.offsetAt(item));
        offset = nextOffset;
      }

      begin_row += 1;
      begin_col = 1;
    } while (begin_row <= end_row);
  }

  return {
    data: items
      .sort((a, b) => {
        const d = a.line - b.line;
        return d == 0 ? a.character - b.character : d;
      })
      .flatMap((item, i, items) => {
        if (i == 0)
          return [
            item.line,
            item.character,
            item.length,
            item.tokenType,
            item.tokenModifier,
          ];

        if (item.line == items[i - 1].line) {
          return [
            0,
            item.character - items[i - 1].character,
            item.length,
            item.tokenType,
            item.tokenModifier,
          ];
        }

        return [
          item.line - items[i - 1].line,
          item.character,
          item.length,
          item.tokenType,
          item.tokenModifier,
        ];
      }),
  };
}

connection.onRequest(
  "textDocument/semanticTokens/full",
  onTextDocumentSemanticTokens
);

connection.onRequest(
  "textDocument/semanticTokens/range",
  onTextDocumentSemanticTokens
);

// Listen on the connection
connection.listen();
