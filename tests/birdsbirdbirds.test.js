import { describe, expect, it } from "vitest";
import { TestDriver } from "testdriverai/vitest/hooks";

describe("BirdsBirdBirds Challenge", () => {
  it("allows selecting drawing tools and saving a bird", async (context) => {
    const testdriver = TestDriver(context);

    await testdriver.provision.chrome({
      url: process.env.APP_URL || "https://arcade-quarter-horn-boxing.trycloudflare.com",
    });

    const assertHeader = await testdriver.assert(
      "the Draw your bird header and drawing tools are visible"
    );
    expect(assertHeader).toBeTruthy();

    const saveButton = await testdriver.find("Save my bird button");
    await saveButton.click();

    await testdriver.scroll("down", { amount: 200 });

    const assertEmpty = await testdriver.assert(
      'the message "The canvas is empty. Draw your bird first!" is visible'
    );
    expect(assertEmpty).toBeTruthy();

    await testdriver.scroll("up", { amount: 200 });

    const eraserButton = await testdriver.find("Eraser button");
    await eraserButton.click();

    const assertEraser = await testdriver.assert("the Eraser tool is selected");
    expect(assertEraser).toBeTruthy();

    const penButton = await testdriver.find("Pen button");
    await penButton.click();

    const assertPen = await testdriver.assert("the Pen tool is selected");
    expect(assertPen).toBeTruthy();
  });
});
