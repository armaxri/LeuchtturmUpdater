// Plain JavaScript so the fixture needs no build step. Shows its own version in the status
// bar, which makes it easy to see whether an update through Leuchtturm took effect.
const vscode = require('vscode');

function activate(context) {
  const version = context.extension.packageJSON.version;
  const name = context.extension.packageJSON.displayName;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.text = `$(beaker) ${context.extension.packageJSON.name} ${version}`;
  item.tooltip = `${name} ${version} (installed through Leuchtturm)`;
  item.command = `${context.extension.id}.version`;
  item.show();
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand(`${context.extension.id}.version`, () =>
      vscode.window.showInformationMessage(`${name} ${version} is active.`),
    ),
  );
}

module.exports = { activate };
