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
  StatusBarAlignment,
  StatusBarItem,
} from "vscode";
import * as nls from "vscode-nls";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { getAllTUPaths } from "./utils";

nls.config({
  messageFormat: nls.MessageFormat.bundle,
  bundleFormat: nls.BundleFormat.standalone,
})();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

function createClient(context: ExtensionContext) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(path.join("src", "index.js"));

  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const nodeModule = {
    module: serverModule,
    transport: TransportKind.ipc,
    args: [],
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
    // Register the server for C documents
    documentSelector: [{ language: "c" }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
    },
  };

  // Create the language client and start the client.
  const client = new LanguageClient(
    "languageServerCC",
    "Language Server CC",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();

  context.subscriptions.push(client);
}

function selectTU(context: ExtensionContext) {
  const id = "languageServerCC.selectTU";
  context.subscriptions.push(
    commands.registerCommand(id, async () => {
      const workspaceFolder = workspace.workspaceFolders?.[0];
      const folderPath = workspaceFolder.uri.fsPath;
      const items = workspaceFolder ? await getAllTUPaths(folderPath) : [];
      const tu = await window.showQuickPick(
        items.map((file) => path.relative(folderPath, file)),
        {
          placeHolder: localize("select.tu", "Select Translation Unit"),
        }
      );
      if (tu)
        await workspace.getConfiguration().update("languageServerCC.tu", tu);
    })
  );
  return id;
}

function updateStatus(item: StatusBarItem) {
  item.text = "TU: " + workspace.getConfiguration().get("languageServerCC.tu");
  item.show();
}

async function createStatus(context: ExtensionContext) {
  const item = window.createStatusBarItem(StatusBarAlignment.Left);
  item.command = selectTU(context);
  context.subscriptions.push(
    item,
    workspace.onDidChangeConfiguration(() => updateStatus(item))
  );
  updateStatus(item);
}

export async function activate(context: ExtensionContext) {
  createClient(context);
  createStatus(context);
}
