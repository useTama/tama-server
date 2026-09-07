# Import existing notes

Your twin does not start from nothing. Tama imports an existing Markdown knowledge base into its
configured vault as that memory's starting point, without uploading it to GitHub or any other
service.

During `tama-server setup`, choose **Give it an existing Obsidian / Markdown memory** under
**Existing notes**, then enter a source folder available on that machine. The wizard scans it, shows
the Markdown note count in the final summary, and imports only after confirmation. It does not save
the source path in config.

You can also import later with the standalone command:

```sh
tama-server import /path/to/second-brain
# source checkout:
bun run src/tama.ts import /path/to/second-brain
```

Add `--config /path/to/tama.config.json` when the deployment uses a non-default config. The command:

- reads the source folder without modifying it;
- imports UTF-8 `.md` files and preserves their relative folders and filenames, so Obsidian
  `[[wiki-links]]` continue to resolve;
- skips dot-directories, nested symlinks and non-Markdown files;
- treats an identical destination file as already imported;
- refuses to overwrite a different destination file;
- sends no network requests and does not run `git add`, `git commit` or `git push`.

The destination must be a separate, configured Tama vault that passes the normal git-backed-vault
preflight. `git init` creates only local metadata; it does not publish anything or create a remote.

## Import on the same machine

First run `tama-server setup` and choose a new non-iCloud folder for the Tama vault. Then import the
old notes folder:

```sh
tama-server import "/path/to/second-brain"
```

Do not configure Tama to write directly into an iCloud, Dropbox or OneDrive folder. Import into a
separate local vault so captures keep their atomic-write and conflict-safety guarantees.

## Import to a remote deployment without GitHub

Create/configure the Tama vault on the server first. Copy only Markdown to a private staging folder
over SSH:

```sh
rsync -av --prune-empty-dirs \
  --include='*/' --include='*.md' --include='*.MD' --exclude='*' \
  "/path/to/second-brain/" deploy@your-server:~/tama-import/
```

Then connect to the server and import it:

```sh
tama-server import ~/tama-import --config ~/.config/tama/tama.config.json
```

Verify the resulting notes before removing the private staging copy. If the original Obsidian vault
uses images, PDFs or other attachments, transfer those separately after review; Tama Ask indexes
Markdown only and the import command deliberately avoids copying arbitrary files or hidden tool
state.
