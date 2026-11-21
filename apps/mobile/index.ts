// The app's entry. The polyfills come first: core's gateway client reads them
// when its modules load.
import "./src/polyfills.ts";
import { registerRootComponent } from "expo";
import { App } from "./src/App.tsx";

registerRootComponent(App);
