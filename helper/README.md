# Leuchtturm Remote Helper

Part of [Leuchtturm Updater](https://github.com/armaxri/LeuchtturmUpdater). In a remote window
(Dev Containers, Remote-SSH, WSL), Leuchtturm runs on your local machine, but most extensions
are installed on the remote side, where Leuchtturm cannot see them. This helper runs on the
remote side and answers one question: which extensions, in which versions, are installed here.

It has no settings, no UI and makes no network requests. Leuchtturm installs it when you click
_Install Helper_ in its sidebar; you never need to install it yourself.
