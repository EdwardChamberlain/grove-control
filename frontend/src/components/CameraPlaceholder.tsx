interface CameraPlaceholderProps {
  model?: string | null;
  className?: string;
}

const DEFAULT_CAMERA_PLACEHOLDER = '/img/camera_placeholder.png';

function getCameraPlaceholderUrl(model?: string | null): string {
  const modelName = model?.trim();
  return modelName
    ? `/img/camera_placeholder_${encodeURIComponent(modelName)}.png`
    : DEFAULT_CAMERA_PLACEHOLDER;
}

/**
 * Model-specific camera placeholder with the generic image as its asset fallback.
 */
export function CameraPlaceholder({ model, className }: CameraPlaceholderProps) {
  return (
    <img
      src={getCameraPlaceholderUrl(model)}
      alt=""
      aria-hidden="true"
      className={className}
      onError={(event) => {
        if (event.currentTarget.getAttribute('src') !== DEFAULT_CAMERA_PLACEHOLDER) {
          event.currentTarget.setAttribute('src', DEFAULT_CAMERA_PLACEHOLDER);
        }
      }}
    />
  );
}
