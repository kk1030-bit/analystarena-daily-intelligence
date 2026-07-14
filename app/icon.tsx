import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#d8ff57",
        color: "#171b1d",
        fontSize: 36,
        fontWeight: 900,
        fontFamily: "Arial",
      }}
    >
      A
    </div>,
    size,
  );
}
