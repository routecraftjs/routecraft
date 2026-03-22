import type { ReactNode } from "react";
import { Box, Text } from "ink";

export function Panel({
  title,
  subtitle,
  color = "gray",
  width,
  flexGrow,
  paddingX = 1,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  color?: string;
  width?: number;
  flexGrow?: number;
  paddingX?: number;
  children: ReactNode;
}) {
  // Border adds 2 chars per side; padding adds paddingX per side
  const innerWidth = width ? width - 2 - paddingX * 2 : 20;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={paddingX}
      width={width}
      flexGrow={flexGrow}
    >
      {title && (
        <>
          <Text bold>
            {title}
            {subtitle && <> {subtitle}</>}
          </Text>
          <Text dimColor>{"\u2500".repeat(Math.max(innerWidth, 1))}</Text>
        </>
      )}
      {children}
    </Box>
  );
}
