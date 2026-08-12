/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head_smartformfill_form_review.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_smartformfill_form_review.js",
  this
);

async function openFormReviewSummary(context) {
  const review = await openFormReview(context);

  await respondWithGeneratedFields(context.mockEngineManager, [
    {
      action: "generate",
      value: "generated@example.com",
      confidence: "high",
    },
  ]);
  await waitForFormReviewState(
    review.reviewBrowser,
    FORM_REVIEW_STATES.SUMMARY
  );

  return review;
}

describe("Smart Form Fill form review filling", () => {
  let context;

  beforeEach(async () => {
    context = await setupFormReviewTest();
  });

  afterEach(async () => {
    await cleanupFormReviewTest(context);
    context = null;
  });

  it("fills a generated suggestion from the summary", async () => {
    const { dialog, reviewBrowser } = await openFormReviewSummary(context);

    await activateFormReviewButton(
      reviewBrowser,
      "ai-smart-form-fill-fill-form"
    );
    await waitForFormReviewState(reviewBrowser, FORM_REVIEW_STATES.FINAL);

    Assert.equal(
      await getFormFieldValue(context.win.gBrowser.selectedBrowser, "#email"),
      "generated@example.com",
      "The generated suggestion should be filled into the form"
    );

    const dialogClosed = waitForFormReviewClose(context.win, dialog);
    await activateFormReviewButton(
      reviewBrowser,
      "ai-smart-form-fill-close-review"
    );
    await dialogClosed;
  });

  it("preserves a value added to the page before filling", async () => {
    const { dialog, reviewBrowser } = await openFormReviewSummary(context);

    await typeInFormField(
      context.win.gBrowser.selectedBrowser,
      "#email",
      "user@example.com"
    );
    await activateFormReviewButton(
      reviewBrowser,
      "ai-smart-form-fill-fill-form"
    );
    await waitForFormReviewState(reviewBrowser, FORM_REVIEW_STATES.FINAL);

    Assert.equal(
      await getFormFieldValue(context.win.gBrowser.selectedBrowser, "#email"),
      "user@example.com",
      "Filling should not replace the value already in the field"
    );

    const dialogClosed = waitForFormReviewClose(context.win, dialog);
    await activateFormReviewButton(
      reviewBrowser,
      "ai-smart-form-fill-close-review"
    );
    await dialogClosed;
  });

  it("leaves the form unchanged when generation is stopped", async () => {
    const { dialog, reviewBrowser } = await openFormReview(context);
    const dialogClosed = waitForFormReviewClose(context.win, dialog);

    await activateFormReviewButton(
      reviewBrowser,
      "ai-smart-form-fill-stop-finding-suggestions"
    );
    await dialogClosed;

    Assert.equal(
      await getFormFieldValue(context.win.gBrowser.selectedBrowser, "#email"),
      "",
      "Stopping generation should leave the form field empty"
    );
  });
});
