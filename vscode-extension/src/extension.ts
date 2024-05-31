import * as path from "path";
import {
  commands,
  window,
  workspace,
  ExtensionContext,
  StatusBarAlignment,
  ThemeColor,
  ConfigurationChangeEvent,
} from "vscode";
import * as nls from "vscode-nls";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  DidChangeConfigurationNotification,
} from "vscode-languageclient/node";

nls.config({
  messageFormat: nls.MessageFormat.bundle,
  bundleFormat: nls.BundleFormat.standalone,
})();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

async function startClient(context: ExtensionContext) {
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
    // Set the initial translation unit
    initializationOptions: {
      translationUnit: workspace.getConfiguration().get("languageServerCC.tu"),
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
  await client.start();

  context.subscriptions.push(client);

  const { experimental } = client.initializeResult.capabilities;
  const workspaceFolder = workspace.workspaceFolders?.[0];
  if (experimental?.translationUnits && workspaceFolder) {
    const translationUnits = experimental.translationUnits as string[];
    const dir = workspaceFolder.uri.fsPath;
    const list = translationUnits.map((tu) => path.relative(dir, tu));
    const command = commands.registerCommand(
      "languageServerCC.selectTU",
      async () => {
        const tu = await window.showQuickPick(list, {
          placeHolder: localize("select.tu", "Select Translation Unit"),
        });

        if (tu) {
          await workspace.getConfiguration().update("languageServerCC.tu", tu);
        }
      }
    );

    context.subscriptions.push(command);
  }
}

function createStatus(context: ExtensionContext) {
  const client = context.subscriptions[0] as LanguageClient;
  const status = window.createStatusBarItem(StatusBarAlignment.Left);
  status.command = "languageServerCC.selectTU";

  const update = (event?: ConfigurationChangeEvent) => {
    const section = "languageServerCC.tu";
    const tu = workspace.getConfiguration().get(section);
    status.text = `${tu}`;
    status.tooltip = `Translation Unit: ${tu}`;
    status.backgroundColor = tu
      ? undefined
      : new ThemeColor("statusBarItem.errorBackground");

    status.show();
    if (event) {
      client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: [section, tu],
      });
    }
  };

  update();
  context.subscriptions.push(
    status,
    workspace.onDidChangeConfiguration(update)
  );
}

export async function activate(context: ExtensionContext) {
  await startClient(context);
  createStatus(context);
}
