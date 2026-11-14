import { useState } from "react";
import { useTranslation } from "./i18n";
import { ImageOff } from "./icons";
import type { ImageVersion, ImagePreview as Preview } from "./lib/git";

function ImageSide({
  version,
  path,
  before,
  actualSize,
}: {
  version: ImageVersion | null;
  path: string;
  before: boolean;
  actualSize: boolean;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const src = version?.dataUrl;
  const dimensions = loaded?.src === src ? loaded : null;
  const error = version?.error ?? (src && failed === src ? "imageDecodeFailed" : null);
  return (
    <figure className="image-side">
      <figcaption>
        <strong className={before ? "negative" : "positive"}>
          {t(before ? "imageBefore" : "imageAfter")}
        </strong>
        <span>
          {dimensions && `${dimensions.width} × ${dimensions.height}`}
          {dimensions && version?.size !== null && " · "}
          {version?.size != null &&
            (version.size < 1024
              ? t("imageBytes", { count: version.size })
              : version.size < 1024 * 1024
                ? `${(version.size / 1024).toFixed(1)} KiB`
                : `${(version.size / (1024 * 1024)).toFixed(1)} MiB`)}
        </span>
      </figcaption>
      <div className={`image-canvas${actualSize ? " actual-size" : ""}`}>
        {!version ? (
          <p className="image-placeholder">{t("imageAbsent")}</p>
        ) : error ? (
          <p className="image-placeholder" role="status">
            <ImageOff size={24} />
            {t(error)}
          </p>
        ) : src ? (
          <img
            src={src}
            alt={t(before ? "imageBeforeAlt" : "imageAfterAlt", { path })}
            loading="lazy"
            onLoad={(event) =>
              setLoaded({
                src,
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(src)}
          />
        ) : (
          <p className="image-placeholder">{t("imageUnavailable")}</p>
        )}
      </div>
    </figure>
  );
}

export default function ImagePreview({ images }: { images: Preview[] }) {
  const { t } = useTranslation();
  const [actualSize, setActualSize] = useState(false);
  return (
    <div className="image-previews">
      <div className="image-preview-tools">
        <span>{t("imagePreviews", { count: images.length })}</span>
        <div className="segmented" aria-label={t("imageScale")}>
          <button type="button" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>
            {t("imageFit")}
          </button>
          <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(true)}>
            {t("imageActualSize")}
          </button>
        </div>
      </div>
      {images.map((image) => (
        <section className="image-preview" key={`${image.originalPath ?? ""}:${image.path}`}>
          <h2>{image.originalPath ? `${image.originalPath} → ${image.path}` : image.path}</h2>
          <div className="image-sides">
            <ImageSide
              version={image.before}
              path={image.originalPath ?? image.path}
              before
              actualSize={actualSize}
            />
            <ImageSide
              version={image.after}
              path={image.path}
              before={false}
              actualSize={actualSize}
            />
          </div>
        </section>
      ))}
    </div>
  );
}
