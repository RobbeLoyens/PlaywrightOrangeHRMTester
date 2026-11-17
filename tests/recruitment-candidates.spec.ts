import { readFile } from "node:fs/promises";
import { expect, test } from "../fixtures/auth.fixture";
import {
  candidateRow,
  candidatesRoute,
  cleanupCandidate,
  createCandidate,
  deleteCandidate,
  field,
  fillRequiredFields,
  openCandidateForm,
  searchByKeyword,
} from "../utils/recruitment";

test("adds a candidate with a resume, searches, verifies details, and deletes it", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(90_000);
  const candidate = createCandidate();
  const resume = "Python Engineer CV\nSkills: Python, SQL, PowerShell\n";
  const phone = "0123456789";
  const notes = "Automated recruitment test";
  let candidateMayExist = false;

  try {
    await test.step("Add a candidate and upload a resume", async () => {
      await openCandidateForm(page);
      await fillRequiredFields(page, candidate);
      await field(page, "Contact Number").locator("input").fill(phone);
      await page.locator('input[type="file"]').setInputFiles({
        name: "candidate-cv.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(resume),
      });
      await page
        .getByRole("textbox", { name: "Enter comma seperated words..." })
        .fill(candidate.keyword);
      await field(page, "Notes").locator("textarea").fill(notes);
      candidateMayExist = true;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+(?:[/?#]|$)/);
    });

    await test.step("Find the candidate by name", async () => {
      await page.goto(candidatesRoute, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Candidates", exact: true })).toBeVisible();
      const nameInput = page.getByRole("textbox", { name: "Type for hints..." });
      if (!(await nameInput.isVisible())) {
        await page.locator(".oxd-table-filter-header-options button").click();
      }
      await nameInput.fill(candidate.firstName);
      await page.getByRole("option", {
        name: `${candidate.firstName} ${candidate.lastName}`,
        exact: true,
      }).click();
      const response = page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname.endsWith("/api/v2/recruitment/candidates") &&
          new URL(result.url()).searchParams.has("candidateId"),
      );
      await page.getByRole("button", { name: "Search", exact: true }).click();
      expect((await response).ok()).toBeTruthy();
      await expect(page.locator(".oxd-table-body").getByRole("row")).toHaveCount(1);
      await expect(candidateRow(page, candidate)).toHaveCount(1);
    });

    await test.step("Verify saved candidate details and resume", async () => {
      await candidateRow(page, candidate)
        .locator("button")
        .filter({ has: page.locator(".bi-eye-fill") })
        .click();
      await expect(page.getByRole("textbox", { name: "First Name" })).toHaveValue(
        candidate.firstName,
      );
      await expect(page.getByRole("textbox", { name: "Last Name" })).toHaveValue(
        candidate.lastName,
      );
      await expect(field(page, "Email").locator("input")).toHaveValue(candidate.email);
      await expect(field(page, "Contact Number").locator("input")).toHaveValue(phone);
      await expect(page.getByRole("textbox", { name: "Enter comma seperated words..." })).toHaveValue(
        candidate.keyword,
      );
      await expect(field(page, "Notes").locator("textarea")).toHaveValue(notes);
      const resumeControl = page
        .locator(".orangehrm-file-name")
        .filter({ hasText: "candidate-cv.txt" });
      await expect(resumeControl).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        resumeControl.locator(".bi-download").click(),
      ]);
      expect(await readFile(await download.path(), "utf8")).toBe(resume);
    });

    await test.step("Delete the candidate and verify it is absent", async () => {
      await searchByKeyword(page, candidate.keyword);
      await deleteCandidate(page, candidate);
      candidateMayExist = false;
    });
  } finally {
    if (candidateMayExist) {
      await cleanupCandidate(page, candidate);
    }
  }
});

for (const { description, suffix } of [
  { description: "numbers", suffix: "123" },
  { description: "an emoji", suffix: "\u{1F600}" },
]) {
  test(
    `preserves a candidate name containing ${description}`,
    async ({ authenticatedPage: page }) => {
      test.setTimeout(90_000);
      const candidate = createCandidate(suffix);
      let candidateMayExist = false;
      try {
        await openCandidateForm(page);
        await fillRequiredFields(page, candidate);
        await page
          .getByRole("textbox", { name: "Enter comma seperated words..." })
          .fill(candidate.keyword);
        candidateMayExist = true;
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+(?:[/?#]|$)/);
        await searchByKeyword(page, candidate.keyword);
        const row = page.getByRole("row").filter({ hasText: candidate.uniqueName });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(`${candidate.firstName} ${candidate.lastName}`);
        await deleteCandidate(page, candidate);
        candidateMayExist = false;
      } finally {
        if (candidateMayExist) {
          await cleanupCandidate(page, candidate);
        }
      }
    },
  );
}

test("validates required candidate fields and email", async ({ authenticatedPage: page }) => {
  await openCandidateForm(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Required", { exact: true })).toHaveCount(3);
  await field(page, "Email").locator("input").fill("invalid-email");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field(page, "Email")).toContainText("Expected format: admin@example.com");
  await expect(page.getByRole("heading", { name: "Add Candidate" })).toBeVisible();
});

for (const { file, error } of [
  {
    file: { name: "resume.exe", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") },
    error: "File type not allowed",
  },
  {
    file: { name: "resume.jpg", mimeType: "image/jpeg", buffer: Buffer.from("invalid") },
    error: "File type not allowed",
  },
  {
    file: { name: "oversized.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 1, 65) },
    error: "Attachment Size Exceeded",
  },
]) {
  test(`rejects invalid resume ${file.name}`, async ({ authenticatedPage: page }) => {
    const candidate = createCandidate();
    let candidateMayExist = false;
    try {
      await openCandidateForm(page);
      await fillRequiredFields(page, candidate);
      await page
        .getByRole("textbox", { name: "Enter comma seperated words..." })
        .fill(candidate.keyword);
      await page.locator('input[type="file"]').setInputFiles(file);
      candidateMayExist = true;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(field(page, "Resume").locator(".oxd-input-field-error-message")).toHaveText(error);
      await expect(page.getByRole("heading", { name: "Add Candidate" })).toBeVisible();
    } finally {
      if (candidateMayExist) {
        await cleanupCandidate(page, candidate);
      }
    }
  });
}
