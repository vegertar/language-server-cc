/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from "path";
import {
  commands,
  window,
  workspace,
  ExtensionContext,
  Disposable,
} from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;
let disposables: Disposable[];

export function activate(context: ExtensionContext) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(path.join("src", "index.js"));

  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const config = workspace.getConfiguration("languageServerCC");
  const nodeModule = {
    module: serverModule,
    transport: TransportKind.ipc,
    args: [
      "--db.alias",
      JSON.stringify(config.get("db.alias")),
      "--db.extension",
      config.get("db.extension", "db"),
    ],
  };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: nodeModule,
    debug: {
      ...nodeModule,
      options: debugOptions,
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [{ scheme: "file", language: "c" }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "languageServerCC",
    "Language Server CC",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();

  disposables = [
    commands.registerCommand(
      "languageServerCC.showExpansions",
      async (...args: any[]) => {
        window.showInformationMessage(
          `CodeLens action clicked with args=${args}`
        );
      }
    ),
  ];
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  disposables?.forEach((item) => item.dispose());
  return client.stop();
}
