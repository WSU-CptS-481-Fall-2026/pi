import {
	getCurrentTools,
	registerTool,
	removeTool,
} from "/Users/genevievekochel/Downloads/WSU_Classes/Fall2026/cpts481/pi/packages/ai/src/utils/transcript.ts";

describe("getCurrentTools() - Tool Ordering", () => {
	beforeEach(() => {
		// Reset the tools before each test
		resetTools(); // Assuming there's a function to reset the tools
	});

	it("should return tools in consistent order regardless of registration history", () => {
		// Scenario A: Register, remove, and re-add tools
		registerTool({ name: "x", description: "Tool X" });
		registerTool({ name: "y", description: "Tool Y" });
		removeTool("x");
		registerTool({ name: "x", description: "Tool X" });
		const scenarioA = getCurrentTools().map((tool) => tool.name);

		// Scenario B: Register tools without removal
		resetTools();
		registerTool({ name: "x", description: "Tool X" });
		registerTool({ name: "y", description: "Tool Y" });
		const scenarioB = getCurrentTools().map((tool) => tool.name);

		// Both scenarios should produce the same order
		expect(scenarioA).toEqual(scenarioB);
	});
});
