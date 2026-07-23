import { rem } from "@mantine/core";

interface Props {
  size?: number | string;
}

function IconD2({ size }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0D63F8"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: rem(size), height: rem(size) }}
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
      <rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
      <path d="M10 6.5h4a3.5 3.5 0 0 1 3.5 3.5v4"></path>
    </svg>
  );
}

export default IconD2;
