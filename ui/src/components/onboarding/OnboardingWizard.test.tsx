import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingWizard from "./OnboardingWizard";
import { DEFAULT_PERMISSION_STORAGE_KEY } from "@/lib/permission-default";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: apiMocks.get,
    post: apiMocks.post,
  }),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.get.mockImplementation((url: string) => {
      if (url === "/api/users/me") {
        return Promise.resolve({ data: { user: { name: "Ada Runtime" } }, error: null });
      }
      if (url === "/api/providers") {
        return Promise.resolve({
          data: {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                defaultModel: "gpt-4.1",
                models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
              },
            ],
          },
          error: null,
        });
      }
      if (url === "/api/keys") {
        return Promise.resolve({ data: { keys: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    apiMocks.post.mockImplementation((url: string) => {
      if (url === "/api/keys/openai") return Promise.resolve({ data: { success: true }, error: null });
      if (url === "/api/providers/openai/check") return Promise.resolve({ data: { ok: true, model: "gpt-4.1" }, error: null });
      if (url === "/api/onboarding/complete") return Promise.resolve({ data: { ok: true }, error: null });
      return Promise.resolve({ data: { ok: true }, error: null });
    });
  });

  it("navigates the refreshed steps and completes through the existing callback", async () => {
    const onComplete = vi.fn();
    renderWithLocale(<OnboardingWizard onComplete={onComplete} />);

    expect(await screen.findByDisplayValue("Ada Runtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("heading", { name: "Model access" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Paste provider API key"), { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/keys/openai", { key: "sk-test-key" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/providers/openai/check", { model: "gpt-4.1" }));
    expect(await screen.findByText("Provider connection is ready.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Default permissions" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Full access"));
    expect(window.localStorage.getItem(DEFAULT_PERMISSION_STORAGE_KEY)).toBe("L3_FULL_ACCESS");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Setup summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/onboarding/complete", {
      name: "Ada Runtime",
      provider: "openai",
      skills: [],
      permission_level: "L3_FULL_ACCESS",
    }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
