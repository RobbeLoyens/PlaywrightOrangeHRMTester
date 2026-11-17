import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures/auth.fixture";
import {
  deleteVacancy,
  openVacancyFilter,
  searchVacancy,
  submitVacancySearch,
  vacancyRow,
} from "../utils/recruitment";

const jobTitle = "Software Engineer";
const hiringManager = "manda akhil user";

test("creates, edits, searches, and deletes a Python engineer vacancy", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(90_000);
  const name = `Python Engineer ${randomUUID().slice(0, 8)}`;
  const initialDescription = "Skills: Python";
  const updatedDescription = "Skills: Python, SQL, PowerShell";
  let vacancyMayExist = false;

  try {
    await test.step("Create a Python engineer vacancy", async () => {
      await page.getByRole("link", { name: "Recruitment", exact: true }).click();
      await page.getByRole("link", { name: "Vacancies", exact: true }).click();
      await page.getByRole("button", { name: "Add" }).click();
      await expect(page.getByRole("heading", { name: "Add Vacancy" })).toBeVisible();
      await page
        .locator(".oxd-input-group")
        .filter({ has: page.getByText("Vacancy Name", { exact: false }) })
        .locator("input")
        .fill(name);
      await page
        .locator(".oxd-input-group")
        .filter({ has: page.getByText("Job Title", { exact: false }) })
        .locator(".oxd-select-text")
        .click();
      await page.getByRole("option", { name: jobTitle, exact: true }).click();
      await page.getByRole("textbox", { name: "Type description here" }).fill(initialDescription);
      await page.getByRole("textbox", { name: "Type for hints..." }).fill("manda");
      await page.getByRole("option", { name: hiringManager, exact: true }).click();
      const publishSwitch = page
        .getByText("Publish in RSS Feed and Web Page", { exact: true })
        .locator("..");
      await publishSwitch.locator(".oxd-switch-input").click();
      await expect(publishSwitch.getByRole("checkbox")).not.toBeChecked();
      vacancyMayExist = true;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page).toHaveURL(/\/recruitment\/addJobVacancy\/\d+(?:[/?#]|$)/);
    });

    await test.step("Edit the vacancy to add SQL and PowerShell", async () => {
      const row = await searchVacancy(page, name);
      await expect(row).toHaveCount(1);
      await row.locator("button").filter({ has: page.locator(".bi-pencil-fill") }).click();
      const description = page.getByRole("textbox", { name: "Type description here" });
      await expect(description).toHaveValue(initialDescription);
      await description.fill(updatedDescription);
      const updateResponse = page.waitForResponse(
        (response) =>
          /\/api\/v2\/recruitment\/vacancies\/\d+$/.test(new URL(response.url()).pathname) &&
          response.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      expect((await updateResponse).ok()).toBeTruthy();
    });

    await test.step("Search for the vacancy and verify the saved skills", async () => {
      const row = await searchVacancy(page, name);
      await expect(page.locator(".oxd-table-body").getByRole("row")).toHaveCount(1);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(jobTitle);
      await row.locator("button").filter({ has: page.locator(".bi-pencil-fill") }).click();
      await expect(page.getByRole("textbox", { name: "Type description here" })).toHaveValue(
        updatedDescription,
      );
    });

    await test.step("Delete the vacancy and verify it is no longer searchable", async () => {
      const row = await searchVacancy(page, name);
      await deleteVacancy(page, row);
      await expect(row).toHaveCount(0);
      await openVacancyFilter(page);
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
      vacancyMayExist = false;
    });
  } finally {
    if (vacancyMayExist) {
      await openVacancyFilter(page);
      const option = page.getByRole("option", { name, exact: true });
      if (await option.count()) {
        await option.click();
        await submitVacancySearch(page);
        const row = vacancyRow(page, name);
        await expect(row).toHaveCount(1);
        await deleteVacancy(page, row);
        await expect(row).toHaveCount(0);
        await openVacancyFilter(page);
        await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
      }
    }
  }
});
