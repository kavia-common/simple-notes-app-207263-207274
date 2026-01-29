import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Retro Notes header", () => {
  render(<App />);
  const title = screen.getByText(/retro notes/i);
  expect(title).toBeInTheDocument();
});
