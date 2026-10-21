// Reference face proportions for refineFace(), measured on a real-face GLB: a 478-landmark
// MediaPipe face mesh with 42 ARKit morph targets (face-model-blendshapes.glb). The mesh was
// levelled (yaw removed) and every length normalised so it does not depend on the mesh's scale:
//   W  = cheek-to-cheek width (landmarks 234–454)
//   E  = chin-to-eye-line height (landmark 152 to the mean of the eye corners 33/133/263/362)
//   dz = how far a landmark sits in front of the eye-corner plane, as a fraction of W
// Only the base shape is used; the GLB's morph targets are not read or copied.

export const FACE_REFERENCE = {
	eyeSeparationW: 0.4296, // eye centre to eye centre
	eyeWidthW: 0.2028, // corner to corner, mean of the two eyes
	mouthWidthW: 0.3704, // landmarks 61–291
	depth: {
		noseTip: { t: 0.649, dz: 0.182 },
		lips: { t: 0.403, dz: 0.09 },
		chin: { t: 0.0, dz: 0.035 },
	},
	// Mean cheek/forehead color of the photo the mesh was fitted to (sRGB 0–255)
	skinRGB: [230, 176, 148],
};
