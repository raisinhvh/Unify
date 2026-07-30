import * as vscode from "vscode";
import { UnifyController } from "./controller";

let controller: UnifyController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new UnifyController(context);
  context.subscriptions.push(controller);
  await controller.activate();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
