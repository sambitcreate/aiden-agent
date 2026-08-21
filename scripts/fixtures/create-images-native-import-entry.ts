import { app } from "electron";
import { CreateImagesService } from "../../main/services/create-images/create-images-service";
import { ingestCreateImagesImageFile } from "../../main/services/create-images/electron-asset-import";

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  const root = process.argv[3];
  const workspacePath = process.argv[4];
  if (!imagePath || !root || !workspacePath) {
    throw new Error("Native image import canary requires image, asset, and workspace paths.");
  }
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  const service = new CreateImagesService(root, { workspaceRequired: true });
  await service.workspace.configureChosenDirectory(workspacePath);
  await service.initialize();
  const imported = await ingestCreateImagesImageFile(service.assets, imagePath);
  const workspace = await service.workspace.status();
  process.stdout.write(
    `AIDEN_CREATE_IMAGES_NATIVE_IMPORT=${JSON.stringify({
      mediaType: imported.asset.mediaType,
      width: imported.asset.width,
      height: imported.asset.height,
      displayName: imported.asset.displayName,
      workspaceState: workspace.state,
      importedCount: workspace.importedCount,
    })}\n`,
  );
  app.quit();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "Native image import failed."}\n`,
  );
  process.exitCode = 1;
  app.quit();
});
